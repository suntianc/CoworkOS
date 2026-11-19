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
  for (const { spelled, target } of namedPaths(input, root, userHome))
    if (!reachable(root, target)) return refusal(spelled);
  for (const text of strings(input))
    for (const name of PRIVATE_NAMES) if (text.includes(name)) return refusal(name);
  return undefined;
}

/** Every path inside `root` a tool call names, as written and resolved. */
function* namedPaths(
  input: unknown,
  root: string,
  userHome: string
): Generator<{ spelled: string; target: string }> {
  const forms = spellings(root, userHome);
  for (const text of strings(input))
    for (const { prefix, expand } of forms) {
      const pattern = new RegExp(`${escape(prefix)}(?=$|[/\\s'"\`;|&<>()])(${PATH_TAIL})`, "g");
      for (const match of text.matchAll(pattern)) yield { spelled: match[0], target: resolve(expand(match[1])) };
    }
}

function refusal(path: string): PrivateDataRefusal {
  return { path, pattern: "CoworkOS data home", reason: privateDataReason(path) };
}

/**
 * Parts of the install an Agent is meant to read: the bundled skills, and the
 * guides those skills link to.
 */
const INSTALL_READABLE = [join(".pi", "skills"), "docs"];

export function installReason(path: string): string {
  return (
    `${path} is CoworkOS's own program (its source and installed files); agents may not read, list or run it. ` +
    `When a CoworkOS rule or tool refuses something, its message is the whole answer: ` +
    `follow it, or ask the user, instead of reading how the rule is implemented.`
  );
}

/**
 * The refusal for one tool call that names CoworkOS's own program, or undefined.
 *
 * A Main once spent the three minutes a Subagent was waiting on it reading
 * the protected-path code to work out why a write was refused, after an
 * earlier one had read the backend's credential the same way. Nothing a task
 * needs is in the install beyond its skills and their guides. When the user's
 * project is CoworkOS itself (or contains it), the install is the work, and
 * nothing is refused.
 */
export function installRefusal(
  input: unknown,
  installRoot: string,
  projectDirectory: string,
  userHome: string = homedir()
): PrivateDataRefusal | undefined {
  const root = resolve(installRoot);
  const project = resolve(projectDirectory);
  const within = (target: string, parent: string) => target === parent || target.startsWith(parent + sep);
  if (within(project, root) || within(root, project)) return undefined;
  for (const { spelled, target } of namedPaths(input, root, userHome))
    if (!INSTALL_READABLE.some((entry) => within(target, join(root, entry))))
      return { path: spelled, pattern: "CoworkOS install", reason: installReason(spelled) };
  return undefined;
}
