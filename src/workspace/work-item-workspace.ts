import { mkdir, readdir, realpath, rmdir, stat } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { ProjectDataInvalidError } from "../domain/project-ledger.js";
import { assertRepository, developmentWorkspaceIsIntact, git } from "./development-workspace.js";

/** One work item's own checkout, forked from the requirement's integration site. */
export interface WorkItemSite {
  /** The requirement checkout this item is collected into; never written by the item. */
  developmentDirectory: string;
  directory: string;
  branch: string;
}

function invalid(message: string): ProjectDataInvalidError {
  return new ProjectDataInvalidError(message);
}

async function emptyDirectory(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length === 0;
    // eslint-disable-next-line no-restricted-syntax -- 目录不存在或不可读时按非空处理，调用方据此拒绝复用，宁可报冲突也不覆盖别人的内容
  } catch {
    return false;
  }
}

async function branchAt(directory: string, branch: string): Promise<string | undefined> {
  try {
    return await git(directory, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    // eslint-disable-next-line no-restricted-syntax -- 工作项分支首次启动时尚不存在，rev-parse 失败返回 undefined 让调用方从集成现场 HEAD 新建
  } catch {
    return undefined;
  }
}

/**
 * The isolated checkout one work item runs in.
 *
 * Spec decision 4 separates the requirement's integration site from the sites of
 * its parallel subtasks. The item's first start forks the integration site's
 * current commit onto its own branch, so two parallel items can neither see nor
 * overwrite each other, the integration checkout or the user's working tree;
 * Main collects results explicitly afterwards.
 *
 * A later start of the *same* item — retry, resume after a restart, rework — keeps
 * the directory and branch exactly as they were left. Its commits and files are
 * never reset, deleted or recreated, because the branch and worktree are the
 * item's recorded identity, not a per-attempt copy.
 */
export async function prepareWorkItemSite(site: WorkItemSite): Promise<void> {
  await assertRepository(site.developmentDirectory);
  const development = await realpath(site.developmentDirectory);
  const parent = dirname(site.directory);
  // eslint-disable-next-line no-restricted-syntax -- 父目录此时可能还没有创建，realpath 失败时退回字面路径只用于越界比较，下面的 mkdir 会创建它
  const resolvedParent = await realpath(parent).catch(() => resolve(parent));
  const target = resolve(resolvedParent, basename(site.directory));
  if (target === development || target.startsWith(`${development}${sep}`))
    throw invalid(`工作项现场不能放在需求集成现场内（${site.directory}）`);
  if (!site.branch.trim()) throw invalid("工作项现场缺少分支名");

  if (
    await developmentWorkspaceIsIntact({
      repository: site.developmentDirectory,
      directory: site.directory,
      branch: site.branch
    })
  )
    return;

  // A directory that is not this item's checkout is somebody else's work: keep
  // it and report the conflict instead of deleting or reusing it.
  // eslint-disable-next-line no-restricted-syntax -- 现场目录首次创建时还不存在，stat 的 ENOENT 表示没有需要保留的既有目录
  const existing = await stat(site.directory).catch(() => undefined);
  if (existing) {
    if (!existing.isDirectory()) throw invalid(`工作项现场路径不是目录（${site.directory}）`);
    if (!(await emptyDirectory(site.directory)))
      throw invalid(`工作项现场目录已有内容，未覆盖（${site.directory}）`);
    await rmdir(site.directory);
  }

  await mkdir(dirname(site.directory), { recursive: true, mode: 0o700 });
  const branch = await branchAt(site.developmentDirectory, site.branch);
  const base = branch ?? (await git(site.developmentDirectory, ["rev-parse", "HEAD"]));
  try {
    if (branch)
      // The item's own branch still exists: resume it, keeping everything it
      // already contains. No reset to the integration site's newer HEAD.
      await git(site.developmentDirectory, ["worktree", "add", site.directory, site.branch]);
    else await git(site.developmentDirectory, ["worktree", "add", "-b", site.branch, site.directory, base]);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : String(error));
  }
  if (
    !(await developmentWorkspaceIsIntact({
      repository: site.developmentDirectory,
      directory: site.directory,
      branch: site.branch
    }))
  )
    throw invalid(`工作项现场创建后无法确认分支 ${site.branch}（${site.directory}）`);
}
