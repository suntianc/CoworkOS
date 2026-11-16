/** Failure evidence is the execution event's own flag. */
export function toolExecutionFailed(event) {
  return event?.isError === true;
}
