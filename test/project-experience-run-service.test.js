import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ProjectExperienceStore,
  projectExperienceIdentity
} from "../dist/src/runtime/project-experience-store.js";
import { readProjectExperienceEvidence } from "../dist/src/runtime/project-experience-evidence.js";
import { RunService } from "../dist/src/runtime/run-service.js";
import { createLoadSkillTool, discoverSkills } from "../dist/src/runtime/skill-registry.js";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";
import { PROJECT_EXPERIENCE_ENABLED } from "../dist/src/domain/project-experience.js";

/** Project experience is switched off (#33); its enabled paths return with the switch or go in P9. */
const switchedOff = PROJECT_EXPERIENCE_ENABLED ? false : "项目经验已整套停用（#33），P9 清理时随代码删除";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "atria-project-experience-run-"));
  const previousHome = process.env.ATRIA_HOME;
  process.env.ATRIA_HOME = join(root, "home");
  t.after(async () => {
    if (previousHome === undefined) delete process.env.ATRIA_HOME;
    else process.env.ATRIA_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  const workspaceRoot = join(root, "workspace");
  const workspace = new LocalWorkspaceStore(workspaceRoot);
  const identity = {
    projectId: "project-parser",
    projectDirectory: join(root, "parser"),
    projectCatalogPath: join(root, "project-catalog.json")
  };
  await mkdir(identity.projectDirectory, { recursive: true });
  const store = new ProjectExperienceStore(identity);
  const requests = [];
  const failures = [];
  let handle = () => ({ text: "Current project task completed." });
  const provider = await modelProtocolFixture("openai-completions", async (body) => {
    requests.push(body);
    try {
      return await handle(body);
    } catch (error) {
      failures.push(error);
      return { text: "Fixture assertion failed." };
    }
  });
  t.after(() => provider.close());
  const run = async (taskId, extra = {}, createTask = true) => {
    if (createTask) await workspace.createTask(taskId, { ...identity, goal: "Check the parser project." });
    const result = await new RunService(workspaceRoot).runPi({
      taskId,
      runId: `run-${taskId}`,
      prompt: "Check the parser project using the current project guidance.",
      baseUrl: provider.baseUrl,
      apiKey: "fixture",
      model: "protocol-fixture",
      api: "openai-completions",
      thinkingLevel: "off",
      supportsReasoningEffort: false,
      tools: () => new Map(),
      timeoutMs: 10000,
      maxErrorRetries: 0,
      ...extra
    });
    assert.deepEqual(failures, [], "the local provider checked the actual model requests");
    assert.equal(result.termination, "completed");
    return result;
  };
  return {
    root,
    workspaceRoot,
    workspace,
    identity,
    store,
    requests,
    run,
    setHandler: (next) => {
      handle = next;
    }
  };
}

function systemText(body) {
  return JSON.stringify(body.messages.filter((message) => message.role === "system"));
}

function lastToolText(body) {
  return JSON.stringify([...body.messages].reverse().find((message) => message.role === "tool")?.content);
}

async function publishExperienceAndSkill(store) {
  await store.configure({ enabled: true, learningEnabled: true, autoActivate: true });
  await store.save({
    kind: "experience",
    title: "Parser compatibility",
    description: "Project parser contract",
    content: "PROJECT_EXPERIENCE_FACT: Preserve unknown parser fields."
  });
  for (let index = 0; index < 3; index++) {
    await store.applyProposal({
      taskId: `previous-parser-task-${index}`,
      runId: "previous-run",
      expectedGeneration: (await store.read()).generation,
      verified: true,
      changes: [
        {
          kind: "skill",
          title: "Check parser compatibility",
          description: "Check preservation of unknown fields when changing this project's parser.",
          content: "LEARNED_SKILL_BODY: Run the existing parser compatibility tests and inspect the result.",
          quote: "The parser compatibility tests checked unknown field preservation.",
          validationQuote: "parser compatibility tests passed"
        }
      ]
    });
  }
  await store.configure({ learningEnabled: false });
  const skill = (await store.readProfile()).skills[0];
  assert.ok(skill, "independent prior Tasks published an active managed Skill");
  return { ...skill, name: `learned-${skill.id}` };
}

test(
  "RunService lazily loads managed project Skills, revokes them during a Run, and preserves the caller's load_skill",
  { timeout: 30000, skip: switchedOff },
  async (t) => {
    const f = await fixture(t);
    const skill = await publishExperienceAndSkill(f.store);
    const manualRoot = join(f.identity.projectDirectory, ".pi", "skills", "hand-authored");
    await mkdir(manualRoot, { recursive: true });
    const manualSource =
      "---\nname: hand-authored\ndescription: Existing manually authored project workflow.\n---\nMANUAL_SKILL_BODY: Follow the project's original workflow.\n";
    await writeFile(join(manualRoot, "SKILL.md"), manualSource);
    const originalLoad = {
      ...createLoadSkillTool(await discoverSkills([manualRoot])),
      description: "ORIGINAL_CALLER_SKILL_LOADER: Load the selected project's existing workflow.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "ORIGINAL_CALLER_SKILL_NAME" } },
        required: ["name"],
        additionalProperties: false
      }
    };
    let step = 0;
    f.setHandler(async (body) => {
      step++;
      if (step === 1) {
        const loader = body.tools.find((tool) => tool.function?.name === "load_skill")?.function;
        assert.match(loader?.description, /ORIGINAL_CALLER_SKILL_LOADER/);
        assert.match(loader?.parameters.properties.name.description, /ORIGINAL_CALLER_SKILL_NAME/);
        assert.match(systemText(body), /PROJECT_EXPERIENCE_FACT/);
        assert.ok(systemText(body).includes(skill.name));
        assert.doesNotMatch(systemText(body), /LEARNED_SKILL_BODY|MANUAL_SKILL_BODY/);
        return { name: "load_skill", arguments: { name: skill.name } };
      }
      if (step === 2) {
        assert.match(lastToolText(body), /LEARNED_SKILL_BODY/);
        await f.store.configure({ enabled: false });
        return { name: "load_skill", arguments: { name: skill.name } };
      }
      if (step === 3) {
        assert.doesNotMatch(systemText(body), /PROJECT_EXPERIENCE_FACT/);
        assert.ok(!systemText(body).includes(skill.name));
        assert.doesNotMatch(lastToolText(body), /LEARNED_SKILL_BODY/);
        assert.match(lastToolText(body), /unknown skill/i);
        return { name: "load_skill", arguments: { name: "hand-authored" } };
      }
      assert.equal(step, 4);
      assert.doesNotMatch(systemText(body), /PROJECT_EXPERIENCE_FACT/);
      assert.match(lastToolText(body), /MANUAL_SKILL_BODY/);
      return { text: "Current project task completed." };
    });
    const result = await f.run("load-disable", {
      tools: () => new Map([["load_skill", originalLoad]])
    });
    assert.equal(result.taskStatus, "completed");
    assert.equal(f.requests.length, 4, "the actual host completed all three tool calls");
    assert.equal(await readFile(join(manualRoot, "SKILL.md"), "utf8"), manualSource);
    assert.equal((await f.store.read()).pending.length, 0);
  }
);

test(
  "corrupt optional project data cannot block the caller's manual Skill but fails closed for managed Skills",
  { timeout: 30000, skip: switchedOff },
  async (t) => {
    const f = await fixture(t);
    const skill = await publishExperienceAndSkill(f.store);
    const manualRoot = join(f.identity.projectDirectory, ".pi", "skills", "hand-authored");
    await mkdir(manualRoot, { recursive: true });
    await writeFile(
      join(manualRoot, "SKILL.md"),
      "---\nname: hand-authored\ndescription: Existing project workflow.\n---\nMANUAL_SKILL_AFTER_CORRUPTION"
    );
    const originalLoad = createLoadSkillTool(await discoverSkills([manualRoot]));
    let step = 0;
    f.setHandler(async (body) => {
      step++;
      if (step === 1) {
        assert.match(systemText(body), /PROJECT_EXPERIENCE_FACT/);
        await writeFile(f.store.path, "{broken-project-experience");
        return { name: "load_skill", arguments: { name: "hand-authored" } };
      }
      assert.doesNotMatch(systemText(body), /PROJECT_EXPERIENCE_FACT/);
      assert.ok(!systemText(body).includes(skill.name));
      if (step === 2) {
        assert.match(lastToolText(body), /MANUAL_SKILL_AFTER_CORRUPTION/);
        return { name: "load_skill", arguments: { name: skill.name } };
      }
      assert.equal(step, 3);
      assert.doesNotMatch(lastToolText(body), /LEARNED_SKILL_BODY/);
      assert.match(lastToolText(body), /unknown skill/i);
      return { text: "Current project task completed." };
    });
    await f.run("corrupt-project", { tools: () => new Map([["load_skill", originalLoad]]) });
    assert.equal(f.requests.length, 3);
    assert.equal(await readFile(f.store.path, "utf8"), "{broken-project-experience");
  }
);

test(
  "RunService completion queues only enabled project learning references without background model requests",
  { timeout: 30000, skip: switchedOff },
  async (t) => {
    const f = await fixture(t);
    const defaults = await f.store.read();
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.learningEnabled, false);
    assert.equal(defaults.autoActivate, false);
    f.setHandler((body) => {
      assert.doesNotMatch(
        systemText(body),
        /Extract reusable PROJECT experience|Independently review proposed project lessons/
      );
      assert.ok(
        !body.tools?.some((tool) => tool.function?.name === "load_skill"),
        "no managed Skill means no new loader tool"
      );
      return { text: "FOREGROUND_RESULT_MUST_NOT_BE_COPIED_TO_INTAKE" };
    });
    await f.run("defaults-off");
    assert.equal((await f.store.read()).pending.length, 0);
    await f.store.configure({ enabled: true });
    await f.run("usage-only");
    assert.equal((await f.store.read()).pending.length, 0);
    await f.store.configure({ enabled: false, learningEnabled: true });
    await f.run("learning-with-usage-disabled");
    assert.equal((await f.store.read()).pending.length, 0);
    await f.store.configure({ enabled: true });
    const startedAt = Date.now();
    const result = await f.run("learning-enabled");
    assert.equal(result.taskStatus, "completed");
    let document = await f.store.read();
    assert.equal(document.pending.length, 1);
    const item = document.pending[0];
    assert.equal(item.taskId, "learning-enabled");
    assert.equal(item.runId, "run-learning-enabled");
    assert.equal(item.attempts, 0);
    assert.ok(
      item.availableAt >= startedAt + 60000,
      "completed work leaves a quiet period before extraction"
    );
    assert.deepEqual(JSON.parse(item.text), {
      identity: f.identity,
      workspaceRoot: f.workspaceRoot,
      taskId: "learning-enabled",
      runId: "run-learning-enabled"
    });
    assert.doesNotMatch(item.text, /FOREGROUND_RESULT|current project guidance/);
    const savedResult = JSON.parse(
      await readFile(join(f.workspaceRoot, item.taskId, result.diagnostics.resultPath), "utf8")
    );
    assert.equal(savedResult.termination, "completed", "the queue refers to a durably completed Run");
    await f.run("next-foreground-task");
    document = await f.store.read();
    assert.equal(document.pending.length, 2);
    assert.ok(document.pending.every((pending) => pending.attempts === 0));
    assert.deepEqual(document.learningRequests, []);
    assert.equal(f.requests.length, 5, "only the five foreground completions reached the model");
    const restarted = new ProjectExperienceStore(f.identity);
    assert.deepEqual(
      (await restarted.read()).pending,
      document.pending,
      "intake survives reopening the store"
    );
  }
);

test(
  "fresh RunService Tasks persist their input project directory so completed intake has readable evidence",
  { timeout: 15000, skip: switchedOff },
  async (t) => {
    const f = await fixture(t);
    const identity = projectExperienceIdentity({}, f.identity.projectDirectory);
    const store = new ProjectExperienceStore(identity);
    await store.configure({ enabled: true, learningEnabled: true });
    await f.run("fresh-project-task", { projectDirectory: identity.projectDirectory }, false);
    assert.equal(
      (await f.workspace.readTask("fresh-project-task")).projectDirectory,
      identity.projectDirectory
    );
    const document = await store.read();
    assert.equal(document.pending.length, 1);
    const reference = JSON.parse(document.pending[0].text);
    assert.deepEqual(reference.identity, identity);
    const evidence = await readProjectExperienceEvidence(reference);
    assert.ok(
      evidence?.sources.length,
      "the background reader accepts the actual terminal Run and project ownership"
    );
    assert.equal(evidence.status, "completed");
    assert.match(JSON.stringify(evidence.sources), /Current project task completed/);
    assert.equal(f.requests.length, 1);
  }
);

test(
  "RunService does not inject Main project experience or managed Skill tools into subagents",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const skill = await publishExperienceAndSkill(f.store);
    await f.store.configure({ learningEnabled: true });
    f.setHandler((body) => {
      assert.doesNotMatch(JSON.stringify(body), /PROJECT_EXPERIENCE_FACT|LEARNED_SKILL_BODY/);
      assert.ok(!JSON.stringify(body).includes(skill.name));
      assert.ok(!body.tools.some((tool) => tool.function?.name === "load_skill"));
      return { text: "Delegated check completed." };
    });
    await f.run("delegated-task", { agentId: "parser-reader" });
    assert.equal(f.requests.length, 1);
    assert.equal((await f.store.read()).pending.length, 0);
  }
);

test(
  "with project experience switched off, a fully enabled store adds nothing to a Run and queues nothing",
  { timeout: 30000, skip: PROJECT_EXPERIENCE_ENABLED && "项目经验已启用" },
  async (t) => {
    const f = await fixture(t);
    await publishExperienceAndSkill(f.store);
    await f.store.configure({ enabled: true, learningEnabled: true });
    const before = (await f.store.read()).pending.length;
    f.setHandler((body) => {
      assert.doesNotMatch(systemText(body), /PROJECT_EXPERIENCE_FACT|Parser compatibility/);
      assert.ok(
        !body.tools?.some((tool) => tool.function?.name === "load_skill"),
        "no managed Skill reaches the Run"
      );
      return { text: "done" };
    });
    await f.run("switched-off");
    assert.equal((await f.store.read()).pending.length, before, "a completed Run queues no learning");
    assert.equal(f.requests.length, 1);
  }
);
