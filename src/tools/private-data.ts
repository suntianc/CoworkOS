import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { atriaHome } from "../../scripts/data-home.cjs";

/**
 * CoworkOS's own data, kept away from an Agent's tool calls.
 *
 * The data home holds the backend's host credential, the model keys, client
 * sessions and the shared database. A Main once read the host credential from
 * `runtime/backend-instance.json` and called the backend's management API with
 * it to change a setting it was refused; nothing an Agent is asked to do needs
 * any of this. Only the directories Agents work in stay reachable: task
 * workspaces, development checkouts and temporary workspaces.
 *
 * Like the protected-path guard this is NOT a sandbox: the Agent's processes
 * run as the same OS user, and a command that builds the path at run time
 * (variables, interpreters, encoded strings) is not seen. It stops a tool call
 * from naming the data home, which is how the incident happened; keeping a
 * determined process out needs OS isolation, which P5 brings for outside work.
 */

/** Data-home entries Agents legitimately work in. */
const WORKING_DIRECTORIES = [
  "workspace",
  join("runtime", "development-workspaces"),
  join("runtime", "temporary-workspaces")
];

/**
 * File names refused anywhere in a call, so a path relative to an allowed
 * directory (`../../backend-instance.json`) is caught too. Only names that
 * are CoworkOS's own: a generic name such as `credentials.json` can be the
 * user's file.
 */
const PRIVATE_NAMES = [
  "backend-instance.json",
  "backend-identity.json",
  "backend-starting.json",
  "project-data.sqlite",
  "client-sessions.json",
  "local-sessions.json"
];

const PATH_TAIL = String.raw`[^\s'"\`;|&<>()]*`;
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface PrivateDataRefusal {
  /** The path as the model wrote it. */
  path: string;
  pattern: string;
  reason: string;
}

export function privateDataReason(path: string): string {
  return (
    `${path} is CoworkOS's own data (credentials, settings, sessions and databases); agents may not read, list or use it. ` +
    `Nothing a task needs is there. If a CoworkOS tool refused because something is not configured, stop and ask the user to set it up.`
  );
}

/** Every string inside a tool call's input. */
function strings(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, found);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, found);
  return found;
}

/** The ways a call can spell the data home: absolute, and through `~` or `$HOME` when it sits in the home folder. */
function spellings(
  home: string,
  userHome: string
): Array<{ prefix: string; expand: (rest: string) => string }> {
  const forms = [{ prefix: home, expand: (rest: string) => home + rest }];
  const inside = relative(userHome, home);
  if (inside && !inside.startsWith("..") && !isAbsolute(inside)) {
    const tail = inside.split(sep).join("/");
    for (const lead of ["~/", "$HOME/", "${HOME}/"])
      forms.push({ prefix: lead + tail, expand: (rest: string) => join(userHome, inside) + rest });
  }
  return forms;
}

function reachable(home: string, target: string): boolean {
  return WORKING_DIRECTORIES.some((entry) => {
    const allowed = join(home, entry);
    return target === allowed || target.startsWith(allowed + sep);
  });
}

/** The refusal for one tool call that names CoworkOS's own data, or undefined. */
export function privateDataRefusal(
  input: unknown,
  home: string = atriaHome(process.env),
  userHome: string = homedir()
): PrivateDataRefusal | undefined {
  const root = resolve(home);
  const forms = spellings(root, userHome);
  for (const text of strings(input)) {
    for (const { prefix, expand } of forms) {
      const pattern = new RegExp(`${escape(prefix)}(?=$|[/\\s'"\`;|&<>()])(${PATH_TAIL})`, "g");
      for (const match of text.matchAll(pattern)) {
        const target = resolve(expand(match[1]));
        if (!reachable(root, target)) return refusal(match[0]);
      }
    }
    for (const name of PRIVATE_NAMES) if (text.includes(name)) return refusal(name);
  }
  return undefined;
}

function refusal(path: string): PrivateDataRefusal {
  return { path, pattern: "CoworkOS data home", reason: privateDataReason(path) };
}
