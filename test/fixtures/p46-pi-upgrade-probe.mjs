import { appendFile } from "node:fs/promises";

/**
 * Test-only extension loaded next to the real Main extension: it records how
 * `before_agent_start` is delivered, sends one message while the first run is
 * still starting, and can start a run from an extension message.
 */
export default function p46UpgradeProbe(pi) {
  const log = process.env.P46_PROBE_LOG;
  let sentDuringStart = false;
  pi.on("before_agent_start", async (event) => {
    if (log)
      await appendFile(
        log,
        `${JSON.stringify({
          messageType: event.messageType,
          hasPrompt: "prompt" in event,
          hasMessage: "message" in event,
          customType: event.messageType === "custom" ? event.message.customType : undefined
        })}\n`
      );
    if (process.env.P46_PROBE_STARTUP !== "1" || sentDuringStart || event.messageType !== "user") return;
    sentDuringStart = true;
    // The run is starting here; 1.2.0 queues this into it instead of failing
    // with "Agent is already processing" or starting a second run.
    await pi.sendMessage(
      { customType: "p46-probe-startup", content: "P46_STARTUP_MARKER", display: false },
      { triggerTurn: true }
    );
  });
  pi.registerCommand("probe-custom", {
    description: "Start one probe run from an extension message",
    handler: async (_args, ctx) => {
      pi.sendMessage(
        { customType: "p46-probe-custom", content: "P46_CUSTOM_MARKER", display: false },
        { triggerTurn: true }
      );
      await ctx.waitForIdle();
    }
  });
}
