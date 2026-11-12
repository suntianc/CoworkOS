/**
 * The supervisor switch retired by #04, when the Main guardian moved into the
 * Run service. It is assembled so scans looking for the old name do not match
 * this definition itself.
 */
export const RETIRED_GUARDIAN_SWITCH = ["COWORK_DISABLE", "WATCH", "SUPERVISOR"].join("_");
