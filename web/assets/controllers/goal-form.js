import { ui } from "../ui/language.js";
import { createModal } from "../ui/modal.js";
import { esc } from "../goal-view.js";
const lines = (value) =>
  String(value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const path = (goal) =>
  `/api/tasks/${encodeURIComponent(goal.taskId)}/goals/${encodeURIComponent(goal.programId)}`;
const examples = [
  {
    title: ui("Claude Code 官方动态"),
    objective: ui(
      "持续关注 Claude Code 的官方发布，使用官方 GitHub 发布订阅。兼容性或安全方面的重要变化及时告诉我，普通更新每周汇总，同一消息不要重复提醒。"
    )
  },
  {
    title: ui("训练进度"),
    objective: ui(
      "帮我跟进当前训练任务的运行状态和训练指标。异常退出、日志长时间停滞或指标达到目标时告诉我，其余时间安静关注。"
    )
  },
  {
    title: ui("等待文件更新"),
    objective: ui("持续关注我指定文件的新内容，只在出现有意义的变化时告诉我。请先与我确认要跟进的文件。")
  }
];

/** A short brief first; names and detailed preferences are optional. */
export function createGoalForm({ api, state, onSaved, onBusy }) {
  const panel = document.createElement("div");
  panel.className = "modal-backdrop";
  panel.hidden = true;
  document.body.append(panel);
  let modal;
  function open(existing) {
    modal?.close();
    const brief = existing?.goal.brief;
    const requestId = crypto.randomUUID();
    const schedule = brief?.digest ?? {
      dayOfWeek: 0,
      hour: 18,
      minute: 0,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    panel.innerHTML = ui`<section class="modal-card goal-form-dialog" role="dialog" aria-modal="true" aria-labelledby="goal-form-title"><header class="goal-form-heading"><div><h2 id="goal-form-title">${existing ? ui("调整目标") : ui("新建目标")}</h2>${existing ? ui("<p>保留已有结果，按新要求继续跟进。</p>") : ""}</div><button type="button" data-form-close aria-label="关闭目标编辑">×</button></header><form><label class="goal-brief-label" for="goal-objective">${existing ? ui("你希望怎样跟进？") : ui("想让 Formicand 替你关注什么？")}</label><textarea id="goal-objective" name="objective" maxlength="4000" required placeholder="例如：关注 Claude Code 官方动态，重要变化及时告诉我，普通更新每周汇总。">${esc(brief?.objective)}</textarea>${existing ? "" : `<div class="goal-examples">${examples.map((example, index) => `<button type="button" data-goal-example="${index}">${esc(example.title)}</button>`).join("")}</div>`}<div class="goal-form-options">${existing ? "" : ui`<label>在哪里跟进<select name="scope"><option value="background">在后台持续跟进</option><option value="session" ${!state.selected ? "disabled" : ""}>在当前对话中跟进</option></select></label>`}<label>什么时候告诉我<select name="notificationPolicy"><option value="important_only">有重要变化或需要我决定时</option><option value="digest">重要变化及时告知，普通内容每周摘要</option><option value="all">每次有意义的更新</option></select></label></div><div data-digest-fields class="goal-digest-fields"><label>每周<select name="dayOfWeek">${[ui("日"), ui("一"), ui("二"), ui("三"), ui("四"), ui("五"), ui("六")].map((day, index) => ui`<option value="${index}" ${index === schedule.dayOfWeek ? "selected" : ""}>星期${day}</option>`).join("")}</select></label><label>时间<input type="time" name="digestTime" value="${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}"></label><label>时区<input name="timeZone" value="${esc(schedule.timeZone)}"></label></div><details class="goal-form-advanced" ${existing ? "open" : ""}><summary>名称与更多要求</summary><label>名称 <span>可选</span><input name="title" maxlength="120" value="${esc(brief?.title)}" placeholder="留空时根据描述命名"></label><label>完成标准 <span>每行一条；留空表示持续关注</span><textarea name="completionCriteria">${esc(brief?.completionCriteria.join("\n"))}</textarea></label><label>你的偏好 <span>每行一条</span><textarea name="preferences" placeholder="只用可靠来源；避免重复提醒">${esc(brief?.preferences.join("\n"))}</textarea></label></details><p role="alert" data-form-error></p><div class="goal-form-footer"><button type="button" data-form-cancel>取消</button><button type="submit" class="goal-primary">${existing ? ui("保存要求") : ui("开始跟进")}</button></div></form></section>`;
    modal = createModal(panel, panel.querySelector("[data-form-close]"));
    panel.querySelector("[data-form-cancel]").addEventListener("click", modal.close);
    const form = panel.querySelector("form");
    form.elements.notificationPolicy.value = brief?.notificationPolicy ?? "important_only";
    const digestFields = () => {
      panel.querySelector("[data-digest-fields]").hidden =
        form.elements.notificationPolicy.value !== "digest";
    };
    form.elements.notificationPolicy.addEventListener("change", digestFields);
    digestFields();
    for (const button of panel.querySelectorAll("[data-goal-example]"))
      button.addEventListener("click", () => {
        const example = examples[Number(button.dataset.goalExample)];
        form.elements.objective.value = example.objective;
        form.elements.title.value = example.title;
        form.elements.objective.focus();
      });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      onBusy(true);
      const values = Object.fromEntries(new FormData(form));
      const [hour, minute] = values.digestTime.split(":").map(Number);
      const nextBrief = {
        title:
          values.title.trim() || Array.from(values.objective.trim().split("\n")[0]).slice(0, 32).join(""),
        objective: values.objective,
        completionCriteria: lines(values.completionCriteria),
        preferences: lines(values.preferences),
        notificationPolicy: values.notificationPolicy,
        ...(values.notificationPolicy === "digest"
          ? { digest: { dayOfWeek: Number(values.dayOfWeek), hour, minute, timeZone: values.timeZone } }
          : {})
      };
      try {
        let saved;
        if (existing) {
          const write = (revision) =>
            api(`${path(existing)}/control`, {
              method: "POST",
              body: { action: "edit", revision, brief: nextBrief }
            });
          try {
            saved = await write(existing.goal.revision);
          } catch (error) {
            if (error.status !== 409) throw error;
            const current = await api(path(existing));
            if (JSON.stringify(current.goal.brief) !== JSON.stringify(existing.goal.brief))
              throw new Error(ui("目标要求已在其他地方修改。草稿已保留，请核对最新要求后重新打开编辑。"));
            saved = await write(current.goal.revision);
          }
        } else
          saved = await api("/api/goals", {
            method: "POST",
            body: {
              brief: nextBrief,
              scope: values.scope,
              requestId,
              ...(values.scope === "session" ? { sourceTaskId: state.selected } : {})
            }
          });
        await onSaved(saved);
        modal.close();
      } catch (error) {
        form.querySelector("[data-form-error]").textContent = error.message;
      } finally {
        submit.disabled = false;
        onBusy(false);
      }
    });
    modal.open();
    form.elements.objective.focus();
  }
  return {
    open,
    get isOpen() {
      return !panel.hidden;
    }
  };
}
