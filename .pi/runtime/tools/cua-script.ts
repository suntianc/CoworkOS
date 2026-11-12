import { Type } from "typebox";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { CuaScriptController, type CuaScriptDispatcher } from "../../../dist/src/tools/cua-script.js";

export function registerCuaScriptTools(
  pi: ExtensionAPI,
  dispatcher: (
    name: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    ctx: ExtensionToolContext
  ) => ReturnType<CuaScriptDispatcher>
) {
  const controller = new CuaScriptController();
  pi.registerTool({
    name: "cua_script",
    label: "CUA JavaScript",
    description:
      "Execute a bounded async JavaScript CUA cell in isolated QuickJS. Explicit state persists between cells: state.win=await cua.computer.select({pid,windowId,mode}); await state.win.observe(); await state.win.act(action); state.tab=await cua.browser.open(url); await state.tab.getByRole('button',{name:'Export'}).click(). Use state for bindings; local let/const do not persist. Await every operation. Window actions use fresh observations. Tab supports getByRole/Label/Text/TestId, chained container locators, nth(index), frame(frameId), clickAt/drag/scroll with fresh screenshot IDs. Browser options observation=aria/screenshot/both/none control capture cost. wait/waitFor reject on timeout unless allowTimeout:true; missing feedback stops further input until reobserved. Supports only currently active CUA tools and emitImage(imageRef), with no shell/filesystem/Node/network APIs. CPU slices max 50ms, memory 64MiB, 64 RPCs, default 15s/max 60s. Errors/cancellation/reset discard state and never retry input. Inspect dispatchStatus and result evidence; sent/unknown cannot be automatically repeated. Returns bounded call summaries and the last four images.",
    parameters: Type.Object(
      {
        code: Type.String({ maxLength: 65536 }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 }))
      },
      { additionalProperties: false }
    ),
    async execute(_id, params, signal, _update, ctx) {
      return controller.execute(
        params,
        (name, body, innerSignal) => dispatcher(name, body, innerSignal, ctx),
        signal
      );
    }
  });
  pi.registerTool({
    name: "cua_reset",
    label: "Reset CUA JavaScript",
    description:
      "Cancel the current CUA cell and discard persistent JavaScript state and pending callbacks. Does not restore human desktop authorization or reset backend browser/desktop ownership. Rebind live windows/tabs before continuing.",
    parameters: Type.Object({}),
    async execute() {
      await controller.reset();
      const details = { vmReset: true };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    }
  });
  return controller;
}
