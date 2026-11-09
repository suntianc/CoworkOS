import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Download,
  type Frame,
  type Locator,
  type Page
} from "playwright-core";
import {
  browserInputs,
  browserUrl,
  BrowserUseError,
  type BrowserAction,
  type BrowserCondition,
  type BrowserLocator,
  type BrowserLocatorAtom,
  type BrowserObservationMode,
  type BrowserOperation
} from "./browser-contracts.js";

export interface BrowserUseOptions {
  taskDirectory: string;
  /** Trusted host configuration only; never a model tool argument. */
  executablePath?: string;
  headless?: boolean;
  maxDownloadBytes?: number;
}
type Dispatch = "not_sent" | "sent" | "unknown";
const MAX_SNAPSHOT_CHARS = 64_000;

/** Task-owned ephemeral Chromium. No user profiles, CDP attachment or page evaluation API. */
export class BrowserUse {
  private browser?: Browser;
  private context?: BrowserContext;
  private launching?: Promise<void>;
  private cleaning?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private active?: AbortController;
  private disposed = false;
  private generation = 0;
  private readonly pages = new Map<string, Page>();
  private readonly pageIds = new WeakMap<Page, string>();
  private readonly openers = new Map<string, string>();
  private readonly frameIds = new WeakMap<Frame, string>();
  private readonly observationEpochs = new WeakMap<Page, number>();
  private readonly registrations = new Set<Promise<void>>();
  private readonly needsObservation = new Set<string>();
  private readonly observations = new Map<
    string,
    { id: string; at: number; width: number; height: number; url: string }
  >();
  private readonly expectedDownloads = new Set<Page>();
  private readonly events: Array<{ type: string; status: string; url?: string }> = [];
  private readonly maxDownloadBytes: number;

  constructor(private readonly options: BrowserUseOptions) {
    this.maxDownloadBytes = options.maxDownloadBytes ?? 20 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxDownloadBytes) || this.maxDownloadBytes < 1)
      throw new Error("Invalid browser download byte limit");
  }

  /** Serialized public operations are also the scripting SDK's backend boundary. */
  execute(
    operation: BrowserOperation,
    input: unknown,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const schema = browserInputs[operation];
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      return Promise.reject(new BrowserUseError("invalid_argument", `Invalid ${operation} input`));
    const generation = this.generation;
    const queued = this.tail.then(async () => {
      if (this.disposed) throw new BrowserUseError("closed", "Browser Use controller is closed");
      if (generation !== this.generation)
        throw new BrowserUseError("session_changed", "Browser session changed; reopen a current Task page");
      if (signal?.aborted) throw new BrowserUseError("cancelled", "Browser operation cancelled");
      const local = new AbortController();
      this.active = local;
      const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
      const value = parsed.data as {
        pageId?: string;
        url?: string;
        action?: BrowserAction;
        condition?: BrowserCondition;
        timeoutMs?: number;
        observation?: BrowserObservationMode;
        observationId?: string;
        frameId?: string;
      };
      const mode = value.observation ?? "both";
      const timeoutMs = value.timeoutMs ?? (operation === "browser_wait" ? 5000 : 10_000);
      const end = Date.now() + timeoutMs;
      const remaining = () => Math.max(1, end - Date.now());
      let dispatched: Dispatch = "not_sent",
        deadlineExceeded = false;
      const abort = () => {
        // eslint-disable-next-line no-restricted-syntax -- 中止触发的关闭是尽力清理；clear() 已先重置浏览器与页面状态，操作本身会以 cancelled 抛出
        void this.clear().catch(() => {});
      };
      combined.addEventListener("abort", abort, { once: true });
      // Locator/navigation waits use the shared deadline; this bounds launch/download IO too.
      const timer = setTimeout(() => {
        deadlineExceeded = true;
        local.abort();
      }, timeoutMs + 2000);
      try {
        if (operation === "browser_close") {
          if (!value.pageId) {
            await this.clear();
            return { closed: "all", pages: [] };
          }
          const page = this.page(value.pageId);
          await page.close();
          if (!this.pages.size) await this.clear();
          return { closed: value.pageId, pages: this.pageList() };
        }
        if (operation === "browser_open") {
          const url = browserUrl(value.url!);
          await this.ensure(remaining(), combined);
          if (this.pages.size >= 8)
            throw new BrowserUseError(
              "page_limit",
              "Browser Use supports at most 8 pages per Task controller"
            );
          const page = await this.context!.newPage();
          const pageId = this.pageIds.get(page) ?? this.registerPage(page);
          if (!pageId || page.isClosed())
            throw new BrowserUseError("page_limit", "Browser page limit reached");
          try {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: remaining(), signal: combined });
          } catch (error) {
            this.pages.delete(pageId);
            // eslint-disable-next-line no-restricted-syntax -- 导航失败的页面已被移出 pages，关闭失败由下面重新抛出的导航错误承接
            await page.close().catch(() => {});
            throw error;
          }
          try {
            return await this.observe(pageId, remaining(), combined, mode, value.frameId);
          } catch (error) {
            if (!(error instanceof BrowserUseError) || error.errorCode !== "observation_changed") throw error;
            // DOMContentLoaded can precede initial iframe navigation. Recapture once,
            // without replaying navigation or input, so open can return a stable pageId.
            return await this.observe(pageId, remaining(), combined, mode, value.frameId);
          }
        }
        const page = this.page(value.pageId!);
        if (operation === "browser_observe")
          return await this.observe(value.pageId!, remaining(), combined, mode, value.frameId);
        if (operation === "browser_wait") {
          const condition = value.condition!;
          if (condition.type === "url") browserUrl(condition.url);
          const started = Date.now();
          let met = false;
          for (;;) {
            combined.throwIfAborted();
            met = await this.matches(page, condition);
            if (met || Date.now() >= end) break;
            await delay(Math.min(50, remaining()), undefined, { signal: combined });
          }
          return await this.after(
            value.pageId!,
            { status: met ? "condition_met" : "timeout", elapsedMs: Date.now() - started, condition },
            remaining(),
            combined,
            mode,
            value.frameId
          );
        }
        if (this.needsObservation.has(value.pageId!))
          throw new BrowserUseError(
            "observation_required",
            "Previous input or feedback is uncertain; observe this page before another action",
            "not_sent",
            true
          );
        const action = value.action!;
        const coordinate = action.type === "click_at" || action.type === "drag" || action.type === "scroll";
        if (coordinate) this.validateCoordinates(value.pageId!, value.observationId, action);
        this.observations.delete(value.pageId!);
        let download: Record<string, unknown> | undefined;
        if (action.type === "navigate") {
          const url = browserUrl(action.url);
          dispatched = "unknown";
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: remaining(), signal: combined });
          dispatched = "sent";
        } else if (coordinate) {
          dispatched = "unknown";
          if (action.type === "click_at")
            await page.mouse.click(action.x, action.y, { button: action.button ?? "left" });
          else if (action.type === "scroll") {
            await page.mouse.move(action.x, action.y);
            await page.mouse.wheel(action.deltaX, action.deltaY);
          } else {
            await page.mouse.move(action.from.x, action.from.y);
            await page.mouse.down();
            try {
              await page.mouse.move(action.to.x, action.to.y, { steps: 12 });
            } finally {
              await page.mouse.up();
            }
          }
          dispatched = "sent";
          combined.throwIfAborted();
        } else {
          const target = await this.locator(page, action.target);
          await this.unique(target);
          if (action.type === "click") {
            await target.click({ trial: true, timeout: remaining(), signal: combined });
            const listening = new AbortController();
            let received: Download | undefined;
            if (action.expectDownload) this.expectedDownloads.add(page);
            // Register before input so an immediate download cannot be missed.
            const pending = action.expectDownload
              ? page
                  .waitForEvent("download", {
                    timeout: remaining(),
                    signal: AbortSignal.any([combined, listening.signal])
                  })
                  .then(
                    (item) => {
                      received = item;
                      return { item };
                    },
                    (error) => ({ error })
                  )
              : undefined;
            try {
              dispatched = "unknown";
              await target.click({ timeout: remaining(), signal: combined });
              dispatched = "sent";
              if (pending) {
                const event = await pending;
                if ("error" in event)
                  throw new BrowserUseError(
                    "download_timeout",
                    "Expected download did not arrive; input was sent. Reobserve before any further action.",
                    "sent",
                    true
                  );
                download = await this.saveDownload(event.item, combined);
              }
            } finally {
              listening.abort();
              this.expectedDownloads.delete(page);
              // eslint-disable-next-line no-restricted-syntax -- 下载已落盘或操作已失败；取消未保存的下载属清理，失败不影响已经确定的返回或抛出结果
              if (received && !download) await received.cancel().catch(() => {});
            }
          } else {
            await target.waitFor({ state: "visible", timeout: remaining(), signal: combined });
            if (!(await target.isEnabled()))
              throw new BrowserUseError("element_disabled", "Target element is disabled");
            dispatched = "unknown";
            if (action.type === "fill")
              await target.fill(action.value, { timeout: remaining(), signal: combined });
            else if (action.type === "press")
              await target.press(action.key, { timeout: remaining(), signal: combined });
            else await target.selectOption(action.value, { timeout: remaining(), signal: combined });
            dispatched = "sent";
          }
        }
        return await this.after(
          value.pageId!,
          {
            dispatchStatus: "sent",
            dispatched: true,
            effectVerified: false,
            ...(download ? { download } : {})
          },
          remaining(),
          combined,
          mode,
          value.frameId
        );
      } catch (error) {
        const certainty = error instanceof BrowserUseError ? error.dispatchStatus : dispatched;
        if (value.pageId && certainty !== "not_sent") {
          this.needsObservation.add(value.pageId);
          this.observations.delete(value.pageId);
        }
        const requiresObservation =
          certainty !== "not_sent" || Boolean(value.pageId && this.needsObservation.has(value.pageId));
        if (combined.aborted) {
          await this.clear();
          throw new BrowserUseError(
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- deadlineExceeded 由下面的 setTimeout 回调写入，TS 在读取处只看到初值 false
            deadlineExceeded ? "timeout" : "cancelled",
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- 同一超时标记：中止来自定时器时为 timeout，来自调用方 signal 时为 cancelled
            deadlineExceeded
              ? "Browser operation timed out"
              : "Browser operation cancelled; owned context closed",
            dispatched,
            requiresObservation
          );
        }
        if (error instanceof BrowserUseError) {
          if (requiresObservation && !error.requiresObservation)
            throw new BrowserUseError(error.errorCode, error.message, error.dispatchStatus, true);
          throw error;
        }
        throw new BrowserUseError(
          "browser_failed",
          "Browser operation failed; inspect the target and explicit wait conditions",
          dispatched,
          requiresObservation
        );
      } finally {
        clearTimeout(timer);
        combined.removeEventListener("abort", abort);
        if (this.active === local) this.active = undefined;
      }
    });
    // eslint-disable-next-line no-restricted-syntax -- 队列尾只用于串行化后续操作，本次操作的失败由返回的 queued 交给调用方；尾部必须变为已兑现，否则后续操作会被前一次失败短路
    this.tail = queued.catch(() => {});
    return queued;
  }

  private event(item: { type: string; status: string; url?: string }) {
    this.events.push(item);
    if (this.events.length > 8) this.events.shift();
  }
  private page(pageId: string): Page {
    const page = this.pages.get(pageId);
    if (!page || page.isClosed())
      throw new BrowserUseError(
        "page_not_found",
        "Unknown or closed pageId; use this Task's browser_open result"
      );
    return page;
  }
  private pageList() {
    return [...this.pages].map(([pageId, page]) => ({
      pageId,
      ...(this.openers.has(pageId) ? { openerPageId: this.openers.get(pageId) } : {}),
      url: page.url().slice(0, 8192),
      ...(page.url().length > 8192 ? { urlTruncated: true } : {})
    }));
  }
  private registerPage(page: Page): string | undefined {
    const existing = this.pageIds.get(page);
    if (existing) return existing;
    if (this.pages.size >= 8 || this.disposed) {
      this.event({ type: "popup", status: "closed_page_limit", url: page.url().slice(0, 2048) });
      // eslint-disable-next-line no-restricted-syntax -- 超出页面上限的弹出页只做关闭清理，关闭失败不影响已记录 closed_page_limit 事件与后续登记流程
      const closing = page.close().catch(() => {});
      this.registrations.add(closing);
      void closing.finally(() => this.registrations.delete(closing));
      return undefined;
    }
    const pageId = `page_${randomUUID()}`;
    this.pages.set(pageId, page);
    this.pageIds.set(page, pageId);
    this.observationEpochs.set(page, 0);
    const invalidate = () => {
      this.observationEpochs.set(page, (this.observationEpochs.get(page) ?? 0) + 1);
      this.observations.delete(pageId);
    };
    page.on("framenavigated", invalidate);
    page.on("frameattached", invalidate);
    page.on("framedetached", invalidate);
    page.once("close", () => {
      this.pages.delete(pageId);
      this.openers.delete(pageId);
      this.needsObservation.delete(pageId);
      invalidate();
    });
    page.on("download", (download) => {
      if (!this.expectedDownloads.has(page)) {
        this.event({ type: "download", status: "cancelled_unrequested" });
        // eslint-disable-next-line no-restricted-syntax -- 未请求的下载已被拒绝，取消失败不影响已记录 cancelled_unrequested 事件，页面继续可用
        void download.cancel().catch(() => {});
      }
    });
    const registration = page
      .opener()
      .then((opener) => {
        const openerPageId = opener && this.pageIds.get(opener);
        if (openerPageId && this.pages.has(pageId)) {
          this.openers.set(pageId, openerPageId);
          this.event({ type: "popup", status: "opened", url: page.url().slice(0, 2048) });
        }
      })
      // eslint-disable-next-line no-restricted-syntax -- opener 查询只是补充 openerPageId 元数据；注册 Promise 会被 observe 的 Promise.all 等待，失败必须就地结束而不是让观察失败
      .catch(() => {});
    this.registrations.add(registration);
    void registration.finally(() => this.registrations.delete(registration));
    return pageId;
  }
  private frameId(frame: Frame) {
    let id = this.frameIds.get(frame);
    if (!id) {
      id = `frame_${randomUUID()}`;
      this.frameIds.set(frame, id);
    }
    return id;
  }
  private frame(page: Page, frameId?: string): Frame {
    if (!frameId) return page.mainFrame();
    const frame = page.frames().find((item) => this.frameIds.get(item) === frameId);
    if (!frame || frame.isDetached())
      throw new BrowserUseError("frame_not_found", "Frame is detached or does not belong to this page");
    return frame;
  }
  private validateCoordinates(pageId: string, observationId: string | undefined, action: BrowserAction) {
    const observed = this.observations.get(pageId),
      viewport = this.page(pageId).viewportSize();
    if (
      !observed ||
      observed.id !== observationId ||
      Date.now() - observed.at > 30_000 ||
      observed.url !== this.page(pageId).url() ||
      viewport?.width !== observed.width ||
      viewport.height !== observed.height
    )
      throw new BrowserUseError(
        "stale_observation",
        "Coordinate input requires this page's fresh screenshot observationId",
        "not_sent",
        true
      );
    const points =
      action.type === "drag"
        ? [action.from, action.to]
        : action.type === "click_at" || action.type === "scroll"
          ? [action]
          : [];
    if (points.some((point) => point.x >= observed.width || point.y >= observed.height))
      throw new BrowserUseError("invalid_argument", "Coordinates are outside the observed CSS viewport");
  }
  private async ensure(timeout: number, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.cleaning) await this.cleaning;
    if (this.context && this.browser?.isConnected()) return;
    if (!this.launching) {
      const generation = this.generation;
      this.launching = (async () => {
        const executablePath =
          this.options.executablePath ?? process.env.COWORK_BROWSER_EXECUTABLE ?? chromium.executablePath();
        if (!isAbsolute(executablePath))
          throw new BrowserUseError(
            "browser_unavailable",
            "COWORK_BROWSER_EXECUTABLE must be an absolute host-configured executable path"
          );
        try {
          await access(executablePath, constants.X_OK);
        } catch {
          throw new BrowserUseError(
            "browser_unavailable",
            "Chromium is unavailable. Install with: npx --yes --package=playwright-core@1.63.0 playwright-core install chromium; or configure COWORK_BROWSER_EXECUTABLE. No browser was installed automatically."
          );
        }
        let browser: Browser | undefined;
        try {
          browser = await chromium.launch({
            executablePath,
            headless: this.options.headless ?? true,
            timeout
          });
          const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
            deviceScaleFactor: 1,
            acceptDownloads: true,
            serviceWorkers: "block"
          });
          if (generation !== this.generation || this.disposed || signal.aborted) {
            await browser.close();
            signal.throwIfAborted();
            throw new BrowserUseError("closed", "Browser context was closed during launch");
          }
          this.browser = browser;
          this.context = context;
          context.on("page", (page) => {
            if (generation === this.generation) this.registerPage(page);
            // eslint-disable-next-line no-restricted-syntax -- 代次已变化的弹出页属于上一次会话，关闭失败不影响当前会话；页面不进入 pages 索引
            else void page.close().catch(() => {});
          });
          browser.once("disconnected", () => {
            if (this.browser === browser) {
              this.browser = undefined;
              this.context = undefined;
              this.pages.clear();
              this.openers.clear();
              this.observations.clear();
              this.needsObservation.clear();
            }
          });
        } catch (error) {
          // eslint-disable-next-line no-restricted-syntax -- 启动失败路径上关闭刚拉起的浏览器，关闭失败由下面重新抛出的启动错误承接
          if (browser && browser !== this.browser) await browser.close().catch(() => {});
          throw error;
        }
      })().finally(() => {
        this.launching = undefined;
      });
    }
    await this.launching;
    signal.throwIfAborted();
  }
  private atom(root: Frame | Locator, target: BrowserLocatorAtom): Locator {
    const locator =
      target.kind === "role"
        ? root.getByRole(target.role, { name: target.name, exact: true })
        : target.kind === "label"
          ? root.getByLabel(target.text, { exact: true })
          : target.kind === "text"
            ? root.getByText(target.text, { exact: true })
            : root.getByTestId(target.text);
    return target.nth === undefined ? locator : locator.nth(target.nth);
  }
  private async locator(page: Page, target: BrowserLocator): Promise<Locator> {
    let root: Frame | Locator = this.frame(page, target.frameId);
    for (const scope of target.scope ?? []) {
      const locator = this.atom(root, scope);
      if ((await locator.count()) > 1)
        throw new BrowserUseError(
          "ambiguous_target",
          "Semantic scope matched multiple elements; specify nth or a unique scope"
        );
      root = locator;
    }
    return this.atom(root, target);
  }
  private async unique(target: Locator) {
    const count = await target.count();
    if (count !== 1)
      throw new BrowserUseError(
        count ? "ambiguous_target" : "target_not_found",
        `Semantic locator matched ${count} elements; specify one unique target`
      );
  }
  private async matches(page: Page, condition: BrowserCondition) {
    if (condition.type === "url") return page.url() === browserUrl(condition.url);
    const target = await this.locator(page, condition.target),
      count = await target.count();
    if (count > 1)
      throw new BrowserUseError(
        "ambiguous_target",
        "Wait locator matched multiple elements; specify one unique target"
      );
    if (condition.state === "detached") return count === 0;
    if (condition.state === "hidden") return count === 0 || !(await target.isVisible());
    if (!count) return false;
    if (condition.state === "attached") return true;
    if (condition.state === "enabled") return target.isEnabled();
    return target.isVisible();
  }
  private async observe(
    pageId: string,
    timeout: number,
    signal: AbortSignal,
    mode: BrowserObservationMode = "both",
    frameId?: string
  ): Promise<Record<string, unknown>> {
    const page = this.page(pageId);
    const frame = this.frame(page, frameId);
    if (mode !== "none") this.needsObservation.add(pageId);
    this.observations.delete(pageId);
    const epoch = this.observationEpochs.get(page);
    const url = page.url();
    const viewport = page.viewportSize()!;
    const snapshot =
      mode === "both" || mode === "aria"
        ? await frame.locator("body").ariaSnapshot({ depth: 8, timeout, signal })
        : undefined;
    const image =
      mode === "both" || mode === "screenshot"
        ? await page.screenshot({ type: "png", scale: "css", timeout, signal })
        : undefined;
    if (image && image.length > 20 * 1024 * 1024)
      throw new BrowserUseError("observation_limit", "Browser screenshot exceeds the byte limit");
    await Promise.all([...this.registrations]);
    const title = await page.title();
    signal.throwIfAborted();
    const currentViewport = page.viewportSize();
    if (
      mode !== "none" &&
      (this.pages.get(pageId) !== page ||
        page.isClosed() ||
        this.observationEpochs.get(page) !== epoch ||
        page.url() !== url ||
        currentViewport?.width !== viewport.width ||
        currentViewport.height !== viewport.height)
    ) {
      this.needsObservation.add(pageId);
      throw new BrowserUseError(
        "observation_changed",
        "Page or viewport changed during capture; observe again before another action",
        "not_sent",
        true
      );
    }
    const observationId = image ? `observation_${randomUUID()}` : undefined;
    if (observationId) this.observations.set(pageId, { id: observationId, at: Date.now(), ...viewport, url });
    if (mode !== "none") this.needsObservation.delete(pageId);
    const frames = page.frames();
    return {
      pageId,
      frameId: this.frameId(frame),
      observationMode: mode,
      observationStatus: mode === "none" ? "omitted" : "captured",
      requiresObservation: this.needsObservation.has(pageId),
      ...(observationId ? { observationId } : {}),
      ...(mode === "none" ? {} : { capturedAt: new Date().toISOString() }),
      url: page.url().slice(0, 8192),
      ...(page.url().length > 8192 ? { urlTruncated: true } : {}),
      title: title.slice(0, 2048),
      ...(mode === "none" ? currentViewport : viewport),
      deviceScaleFactor: 1,
      ...(snapshot === undefined
        ? {}
        : {
            ariaSnapshot: snapshot.slice(0, MAX_SNAPSHOT_CHARS),
            accessibilityTruncated: snapshot.length > MAX_SNAPSHOT_CHARS
          }),
      ...(image ? { image: image.toString("base64"), mimeType: "image/png" } : {}),
      frames: frames.slice(0, 64).map((item) => ({
        frameId: this.frameId(item),
        name: item.name().slice(0, 512),
        url: item.url().slice(0, 8192),
        ...(item.parentFrame() ? { parentFrameId: this.frameId(item.parentFrame()!) } : {})
      })),
      framesTruncated: frames.length > 64,
      pages: this.pageList(),
      popupSupport: "managed",
      events: [...this.events]
    };
  }
  private async after(
    pageId: string,
    result: Record<string, unknown>,
    timeout: number,
    signal: AbortSignal,
    mode: BrowserObservationMode = "both",
    frameId?: string
  ) {
    try {
      const observation = await this.observe(pageId, Math.max(timeout, 1000), signal, mode, frameId);
      return {
        ...result,
        requiresObservation: mode === "none" && this.needsObservation.has(pageId),
        observationMode: mode,
        observationStatus: mode === "none" ? "omitted" : "captured",
        ...(mode === "none"
          ? { pageId, pages: observation.pages, frames: observation.frames }
          : { observation })
      };
    } catch (error) {
      if (signal.aborted) throw error;
      this.needsObservation.add(pageId);
      this.observations.delete(pageId);
      return {
        ...result,
        observationMode: mode,
        observationStatus: "failed",
        requiresObservation: true,
        observationError: error instanceof BrowserUseError ? error.errorCode : "capture_failed",
        pages: this.pageList()
      };
    }
  }
  private async saveDownload(download: Download, signal: AbortSignal) {
    signal.throwIfAborted();
    const path = await download.path();
    if (!path || (await download.failure()))
      throw new BrowserUseError("download_failed", "Download failed after input was sent", "sent", true);
    const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let destination: string | undefined,
      created = false;
    try {
      const info = await source.stat();
      if (!info.isFile() || info.size > this.maxDownloadBytes)
        throw new BrowserUseError(
          "download_limit",
          "Download exceeds the accepted file byte limit",
          "sent",
          true
        );
      const root = await realpath(this.options.taskDirectory);
      let directory = root;
      for (const part of ["visual", "downloads"]) {
        directory = join(directory, part);
        try {
          await mkdir(directory, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const stat = await lstat(directory),
          actual = await realpath(directory),
          rel = relative(root, actual);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          rel === ".." ||
          rel.startsWith(`..${sep}`) ||
          isAbsolute(rel)
        )
          throw new BrowserUseError("download_path", "Download directory escapes the Task", "sent", true);
      }
      const filename =
        basename(download.suggestedFilename())
          .replace(/[^\p{L}\p{N}_.-]/gu, "_")
          .slice(0, 120) || "download";
      const leaf = `dl_${randomUUID()}_${filename}`;
      destination = join(directory, leaf);
      const target = await open(destination, "wx", 0o600);
      created = true;
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        const buffer = Buffer.alloc(64 * 1024);
        for (;;) {
          signal.throwIfAborted();
          const read = await source.read(buffer, 0, buffer.length, bytes);
          if (!read.bytesRead) break;
          if (bytes + read.bytesRead > this.maxDownloadBytes)
            throw new BrowserUseError(
              "download_limit",
              "Download exceeds the accepted file byte limit",
              "sent",
              true
            );
          const chunk = buffer.subarray(0, read.bytesRead);
          hash.update(chunk);
          await target.writeFile(chunk, { signal });
          bytes += read.bytesRead;
        }
      } finally {
        await target.close();
      }
      signal.throwIfAborted();
      return { path: `visual/downloads/${leaf}`, scope: "task", filename, bytes, sha256: hash.digest("hex") };
    } catch (error) {
      // eslint-disable-next-line no-restricted-syntax -- 删除未完成的下载目标是失败路径上的清理；unlink 失败不能覆盖下面重新抛出的原始错误
      if (created && destination) await unlink(destination).catch(() => {});
      throw error;
    } finally {
      await source.close();
    }
  }
  private async clear() {
    if (this.cleaning) return this.cleaning;
    this.generation++;
    const browser = this.browser,
      launching = this.launching;
    this.browser = undefined;
    this.context = undefined;
    this.pages.clear();
    this.openers.clear();
    this.needsObservation.clear();
    this.observations.clear();
    this.expectedDownloads.clear();
    this.events.length = 0;
    this.cleaning = (async () => {
      // eslint-disable-next-line no-restricted-syntax -- 启动失败的拒绝已交给当初 await launching 的调用方；清理仍需继续以确保浏览器被关闭
      if (launching) await launching.catch(() => {});
      // eslint-disable-next-line no-restricted-syntax -- 浏览器与页面状态已在上方重置，关闭失败不影响调用方看到的已清理状态
      if (browser) await browser.close().catch(() => {});
    })().finally(() => {
      this.cleaning = undefined;
    });
    return this.cleaning;
  }
  async dispose() {
    this.disposed = true;
    this.active?.abort();
    await this.clear();
    await this.tail;
  }
  async reset() {
    this.active?.abort();
    await this.clear();
    await this.tail;
  }
}
