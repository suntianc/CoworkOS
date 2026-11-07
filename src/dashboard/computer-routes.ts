import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { ComputerUse, ComputerUseError } from "../gui/computer-use.js";

/** Business clients consume existing grants and can pause or release them. */
export async function handleComputerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  computer: ComputerUse,
  locateTask: (id: string) => Promise<unknown>
): Promise<boolean> {
  if (url.pathname === "/api/computer/access" && request.method === "GET") {
    sendJson(response, 200, computer.access());
    return true;
  }
  if (url.pathname === "/api/computer/status" && request.method === "GET") {
    sendJson(response, 200, await computer.status());
    return true;
  }
  const match = url.pathname.match(
    /^\/api\/tasks\/([^/]+)\/computer(?:\/(observe|act|wait|pause|end|preview|discover|select|release))?$/
  );
  if (!match) return false;
  const taskId = decodeURIComponent(match[1]);
  const epoch = computer.requestEpoch(taskId);
  await locateTask(taskId);
  const operation = match[2];
  if (!operation && request.method === "GET") {
    sendJson(response, 200, { session: computer.current(taskId), access: computer.access(taskId) });
    return true;
  }
  if (operation === "preview" && request.method === "GET") {
    sendJson(response, 200, { preview: computer.preview(taskId) });
    return true;
  }
  if (request.method !== "POST" || !operation) throw new HttpError(405, "method not allowed");
  const body = await readJsonBody(request, 64 * 1024);
  const controller = new AbortController();
  const disconnect = () => {
    if (!response.writableEnded) controller.abort();
  };
  response.once("close", disconnect);
  try {
    if (operation === "pause" || operation === "end") {
      if (operation === "pause") computer.takeOver();
      else computer.stop(taskId, "ended");
      sendJson(response, 200, { session: computer.current(taskId) });
    } else if (operation === "discover") {
      computer.assertRequestEpoch(taskId, epoch);
      sendJson(response, 200, await computer.discover(taskId, controller.signal));
    } else if (operation === "select") {
      computer.assertRequestEpoch(taskId, epoch);
      if (
        !Number.isSafeInteger(body.pid) ||
        Number(body.pid) <= 0 ||
        !Number.isSafeInteger(body.windowId) ||
        Number(body.windowId) <= 0 ||
        (body.mode !== "observe" && body.mode !== "control")
      )
        throw new ComputerUseError(400, "窗口选择参数不合法");
      sendJson(response, 200, {
        session: await computer.select(
          taskId,
          Number(body.pid),
          Number(body.windowId),
          body.mode,
          controller.signal
        )
      });
    } else {
      if (typeof body.sessionId !== "string") throw new ComputerUseError(400, "需要当前会话 ID");
      if (operation === "release")
        sendJson(response, 200, { session: computer.release(taskId, body.sessionId) });
      else if (operation === "preview")
        sendJson(response, 200, {
          preview: await computer.refreshPreview(taskId, body.sessionId, controller.signal)
        });
      else if (operation === "observe")
        sendJson(response, 200, await computer.observe(taskId, body.sessionId, controller.signal));
      else if (operation === "wait") {
        if (body.timeoutMs !== undefined && typeof body.timeoutMs !== "number")
          throw new ComputerUseError(400, "timeoutMs 必须是整数");
        sendJson(
          response,
          200,
          await computer.wait(
            taskId,
            body.sessionId,
            body.condition,
            body.timeoutMs as number | undefined,
            controller.signal
          )
        );
      } else {
        if (typeof body.observationId !== "string") throw new ComputerUseError(400, "需要最近观察 ID");
        if (body.observeAfter !== undefined && typeof body.observeAfter !== "boolean")
          throw new ComputerUseError(400, "observeAfter 必须是布尔值");
        sendJson(
          response,
          200,
          await computer.act(
            taskId,
            body.sessionId,
            body.observationId,
            body.action,
            controller.signal,
            body.observeAfter === true
          )
        );
      }
    }
  } catch (error) {
    if (error instanceof ComputerUseError) {
      sendJson(response, error.status, {
        error: error.message,
        errorCode: error.errorCode,
        dispatchStatus: error.dispatchStatus,
        requiresObservation: error.requiresObservation
      });
      return true;
    }
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
      const metadata = error as Error & {
        errorCode?: string;
        dispatchStatus?: string;
        requiresObservation?: boolean;
      };
      if (!response.destroyed)
        sendJson(response, error.name === "TimeoutError" ? 408 : 409, {
          error: error.message,
          errorCode: metadata.errorCode || (error.name === "TimeoutError" ? "driver_timeout" : "cancelled"),
          dispatchStatus: metadata.dispatchStatus || "not_sent",
          requiresObservation: metadata.requiresObservation ?? operation === "act"
        });
      return true;
    }
    throw error;
  } finally {
    response.off("close", disconnect);
  }
  return true;
}
