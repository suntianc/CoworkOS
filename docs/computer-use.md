# Computer Use 接入

Computer Use 在同一个 CoworkOS 桌面宿主内提供全局授权策略，以及按 Task 隔离的单窗口观察与有限控制。全局策略默认关闭。

窗口访问的期望设置按后端保存。切页、刷新、窗口关闭和渲染进程退出只释放操作会话，取消在途选择并使旧截图凭据失效，不自动暂停正在运行的后端策略；人工接管仍可显式暂停。系统权限被撤销或锁屏时原生操作仍被阻止，但不会清除已保存的期望设置。

原生回归使用隔离测试窗口覆盖控件、Unicode 输入和保存后读取；实际视觉模型及商业应用任务需要单独验收。

## 使用方式

在“设置 → 窗口访问”使用三个按钮：

1. “开启屏幕录制”：只申请屏幕录制权限；实际获准后显示“屏幕录制已开启”并置灰。
2. “开启辅助功能”：只申请辅助功能及必要的输入事件权限；实际获准后显示“辅助功能已开启”并置灰。
3. “开启窗口访问”：只有上述两项权限均确认开启后才可点击。首次开启时，在本机完成系统身份确认；开启后，该后端的所有对话都可观察并操作全部可见普通应用窗口。按钮随后用于关闭访问，关闭时立即撤销临时会话及排队请求。

系统提示中的确认由用户完成。系统记住拒绝决定而不再弹窗时，App 打开对应权限的固定系统设置页。申请返回不代表批准：设置页定时读取实际权限，从系统设置返回 App 时立即刷新；权限未齐全时窗口访问按钮保持禁用，可信宿主也重新核对权限后才允许开启或恢复。系统权限按钮不会顺带开启窗口访问，仍需单独点击第三个按钮。

申请失败可重试；关闭或暂停后，迟到的申请结果不会恢复访问或打开过期授权页。

已有、新建和恢复的对话均按任务需要自行发现、选择窗口。桌面重开时沿用仍在运行的后端实际策略；后端重启后，保存的期望设置显示“等待本机确认”，不会自动开启。审批会话只保存在桌面和后端内存中，有效期为 30 分钟；会话过期、桌面重启或切换后，下一次显式开启、授权或恢复需重新完成本机身份确认。审批会话过期不会自动关闭已经开启的策略。打开应用和查看任务不会触发身份确认。网页和独立 CLI/Web 服务不能自行开启、扩权或恢复此策略。

观察要求 macOS 14+ 和屏幕录制权限；控制还需要辅助功能、输入事件发送权限及解锁桌面。安全键盘输入开启时拒绝控制。窗口访问按钮不能替代系统确认，也不能绕过锁屏。开发 App 使用 ad-hoc 签名，构建身份改变可能再次要求系统授权；稳定签名及升级后的系统权限保留需要独立验收，不承诺永久保留。

全局策略与临时会话分开。Agent 消费策略选择窗口，服务校验 Task、PID、窗口 ID、bundle ID、模式及系统权限，创建新的任务会话。五分钟临时有效期在有效策略范围内自动续期；续期后的操作重新验证系统权限及窗口身份，旧观察凭据失效。重启不恢复 PID、windowId、sessionId、observationId 或截图。

内部保留单窗口协议兼容，source=task 不自动续期；当前界面只创建 mode=control 的全局策略，新任务会话标记 source=global。旧版仅观察策略读取时默认关闭并提示重新开启，原文件保留，避免无意扩大既有只读授权。

同一时刻只有一个 Task 持有桌面观察与连续操作流程，其他 Task 的选择按先后等待。持有者可以在策略内切换窗口，新会话替换旧 ID；完成窗口工作时应调用 computer_release，Run 退出也释放全局临时会话。观察模式不能输入；控制模式支持激活、左右点击、Unicode 输入、快捷键，以及辅助功能控件的按下和设置文本值。优先使用最近观察返回的控件 ID；坐标点击使用最近 PNG 的像素坐标。窗口移动/缩放、关闭、身份或焦点改变，或目标控件身份/状态改变时拒绝旧输入；整屏、Dock、菜单栏、拖拽和滚轮仍未支持。

设置页显示三个按钮、必要的系统权限或暂停提示。操作期间显示当前控制任务、目标窗口和“暂停 · 人工接管”；暂停后才显示恢复入口。界面不读取截图、发放动作凭据或展示倒计时。Agent 仍需根据每次操作后的新截图或 accessibility 文本核对效果。

“暂停 · 人工接管”、Ctrl + Option + Esc（注册成功时）立即取消正在执行与排队的请求，并进入明确暂停状态。全局策略保持开启也不会由工具调用自动恢复，需用户在设置或接管栏点击“恢复窗口访问”；恢复重新创建会话和凭据。任务取消阻止该 Task 后续选择与操作；可信显式恢复或重新授权后才能继续。全局关闭撤销所有临时会话和排队选择。主页面导航/刷新、renderer 崩溃、窗口关闭、工作区切换及服务停止撤销临时会话；导航/崩溃后不进入全局暂停，新请求可以按既有策略重新选择窗口，持久策略不被删除。已发送的物理事件无法撤回，取消只能阻止尚未送出的操作。输入失败后不能复用观察 ID，也不能自动重发结果不确定的动作。

可信宿主再次提交关闭策略同样撤销已有单窗口授权、在途输入、排队请求和未完成的授权；不以设置值是否变化判断撤销。全局关闭时，显式恢复旧单窗口会话仍沿用该次人类授权。同一 Task 在首次选窗校验期间追加的选择，在该 Task 获得控制权后可继续切换窗口；其他 Task 保持先后顺序，等待持有者交还。

普通 Pi bash/jobs 与软件驱动仍使用各自权限机制；此授权不是全产品 OS 沙箱。

## Agent 接口

工具只消费可信宿主已授予的人类策略，不提供开启、扩权或恢复接口。全局开启时 discover/select/observe/act 按模式在首轮可用；暂停时需要人类恢复。

| 工具                | 输入                                   | 输出                                                                                                                                        |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `computer_discover` | `{}`                                   | 策略允许时返回当前可见普通窗口与系统权限；不授予权限                                                                                        |
| `computer_select`   | `{ pid, windowId, mode }`              | 校验窗口并等待独占 Task 会话，返回 session                                                                                                  |
| `computer_release`  | `{ sessionId }`                        | 交还本 Task 控制权，不关闭持久策略                                                                                                          |
| `computer_status`   | `{}`                                   | 当前 Task 的 session 或 null、access（policy、paused、taskBlocked、owner、waitingTaskIds）；未授权或暂停时附系统权限和 nextStep             |
| `computer_observe`  | `{ sessionId }`                        | observationId、尺寸、capturedAt、目标、accessibilityText、结构化 accessibility；支持图像输入的模型另收到原生 PNG 图片块                     |
| `computer_wait`     | `{ sessionId, condition, timeoutMs? }` | status=condition_met/timeout、waitedMs、新 observation 与 PNG；默认 5000 ms，最多 30000 ms                                                  |
| `computer_act`      | `{ sessionId, observationId, action }` | dispatched、dispatchStatus=sent、effectVerified=false、requiresObservation；成功投递后附新 observation 与 PNG；失败返回稳定错误码及投递状态 |

action 是六种明确对象之一：`{ type: "activate" }`、`{ type: "click", x, y, button: "left" | "right" }`、`{ type: "type", text }`、`{ type: "key", keys }`、`{ type: "press", elementId }`、`{ type: "set_value", elementId, value }`。文本和值最多 16 KiB UTF-8、不含 NUL；`set_value` 允许空字符串以清空控件。快捷键是可选 Meta/Control/Alt/Shift 加一个 a-z、0-9 或 Enter/Tab/Escape/Backspace/Delete/方向/Home/End/PageUp/PageDown，不接受 shell。观察最长有效 30 秒，每个实际动作消耗一次观察 ID。投递失败也必须重观察，避免不确定投递被自动重试。`completed` 为兼容字段，仅表示驱动投递完成，不证明目标消费输入或业务完成。

`computer_act` 使用 `observeAfter: true`：投递与后续观察在同一串行队列内执行，等待 100 ms 供目标刷新画面；返回的新图像仍需要模型核对。若操作已投递但抓屏失败，返回 `dispatched: true, dispatchStatus: "sent", effectVerified: false, requiresObservation: true, observationError, observationErrorCode`，不能因此重复发送操作。暂停/过期/断连仍中断整个请求，未确定效果需恢复有效会话后重新观察。

`accessibility` 含 available、truncated 和 elements；每个元素包含 elementId、parentId（如有）、role、name、value（如有）、enabled、actions。树最多 200 个元素、深度 8，文本字段最多 240 个字符。树/字段截断或 AX 读取失败标记 truncated；没有系统权限或找不到该窗口 AX 根时 available=false。辅助功能安全文本控件不返回 value，也不提供动作。只有 actions 列出的 press/set_value 可执行；设置值限于真实可写的文本框、文本区和组合框。原生 helper 在输入前重新读取目标窗口、控件路径、AX 原生 identity 和属性指纹，校验角色、标识、名称、值、启用状态、动作及位置尺寸；同路径的另一个同名控件不得沿用旧 ID。内部路径/身份指纹不返回模型。

elementId 绑定当前 observationId，新观察、wait、动作或会话变更后必须使用新 ID；人工预览不授予动作凭据。

等待条件支持：`{ type: "accessibility_text", text, state: "present" | "absent" }`，或 `{ type: "element", role?, name?, value?, state: "present" | "absent" | "enabled" }`。控件条件至少包含非空 role 或 name，按完整返回字段精确匹配；text/name/value 最多 512 个字符，role 最多 128 个字符。等待只读，在当前任务串行队列内约每 250 ms 重观察；取消、暂停、授权变化或 HTTP 断连立即中断。`condition_met` 证明指定 UI 条件；业务完成仍需检查实际结果。超时返回最近的新观察；如果整个期限内未获得任何观察则返回 wait_capture_timeout。不可用或不完整的辅助功能信息不能证明 absent；截断的值也不能用于确认完整长文本。等待立即废弃旧观察，结束后使用返回的新 observationId/elementId。

失败响应包含 error、errorCode、dispatchStatus、requiresObservation。常见错误码为 invalid_argument、access_denied/session_unavailable、stale_observation/stale_element、element_unavailable、target_changed、native_action_failed、driver_timeout、invalid_driver_response、transport_failed、cancelled。`not_sent` 表示明确拒绝或尚未投递；`sent` 表示已投递；`unknown` 表示驱动/HTTP 中断后不能确定是否已经投递。sent/unknown 均不得自动重发，先恢复有效会话并重观察。即使 native_action_failed，也可能已经影响控件。只读重观察和按条件等待可安全重试，但不能替代业务结果核对。

Pi 的观察、等待及动作后截图会进入 Task 的 `visual/images/`，返回 `imageRef`，可用 `crop_image` 局部裁剪、`read_images` 比较或 `read_image` 重读；详见 [视觉观察](visual-observation.md)。历史引用与 `sourceObservationId` 不发放动作权限。归档失败附 `imageArchive.saved=false` 和错误，仍返回当前像素与输入投递状态；已发送动作不会因归档失败被重发。

纯文本模型只收到 accessibility 信息及图像未投递原因，工具拒绝坐标点击；在已有反馈基础上可激活/输入/按键，或操作结构化控件。截图及辅助功能文本是外部数据，不得改变授权范围。会话管理器的最新帧只在内存中保存，Pi 图片归档与标准对话/trace 可能包含用户内容、工具参数和结果，随 Task 备份保护。会话活动记录不包含输入正文，不能据此宣称所有轨迹都已脱敏。

模型连接的 `supportsImages` 同时作用于 Main、委派及恢复后的 PiSession。运行时保留工具的原生 text/image 内容块，图片以 OpenAI-compatible 图片输入发送，不把 base64 塞进工具文字。未启用视觉时移除图片块并明确告知原因；结构化工具失败保留 isError，取消信号传给工具执行。

## 产品和宿主边界

HTTP 路由复用本机 Host/Origin 和桌面 token 校验：

```text
GET  /api/computer/access
GET  /api/computer/status
GET  /api/tasks/:taskId/computer
GET  /api/tasks/:taskId/computer/preview
POST /api/tasks/:taskId/computer/discover {}
POST /api/tasks/:taskId/computer/select   { pid, windowId, mode }
POST /api/tasks/:taskId/computer/release  { sessionId }
POST /api/tasks/:taskId/computer/preview  { sessionId }
POST /api/tasks/:taskId/computer/observe  { sessionId }
POST /api/tasks/:taskId/computer/wait     { sessionId, condition, timeoutMs? }
POST /api/tasks/:taskId/computer/act      { sessionId, observationId, action, observeAfter?: boolean }
POST /api/tasks/:taskId/computer/pause    {}
POST /api/tasks/:taskId/computer/end      {}
```

状态查询返回可用性、系统权限、controlAvailable、secureInput、postEventAccess 和原因及可见普通应用窗口；会话查询返回 `{ session, access }`，session 含 source、taskId、previewCapturedAt。GET access 只返回策略和所有权元数据，不截图或续建会话；select 只消费已开启策略，不修改持久授权。预览返回 `{ preview }`（最近 PNG、capturedAt、目标和 sessionId，无 observationId），无当前活跃授权则为 null；GET 查询不调用驱动；POST 预览刷新消费已有窗口会话，在串行队列中抓屏，但不发放或替换 observationId。两者均不影响 Agent 动作凭据。观察响应包含 base64 PNG，HTTP 图片用于 UI，模型工具把它转成原生图片块并从文字/details 中移除。缺少授权为 403，旧观察/窗口变化为 409，非法输入为 400，驱动尺寸或 PNG 内容无效为 502；Agent 重新观察失败后旧 observationId 也失效，不能继续按旧图操作。普通驱动调用最长 15 秒，HTTP 断连会取消；旧 Task 授权的有效期可以进一步缩短操作时间。可信宿主可等待系统授权申请至多 5 分钟，供用户处理系统提示；等待期间仍可关闭或暂停。

业务会话 HTTP 和 Agent 不提供 authorize/resume 接口。内部宿主控制接口仅接受实例记录中的宿主凭据和匹配的后端身份，并拒绝带浏览器 Origin 的请求；详情见 [产品 API](product-api.md)。

主窗口主 frame 通过 preload `bookmanDesktop.computerUse` 发可信 IPC；宿主在所选后端数据根的私有 computer-policy.json（version=1，0600）中原子保存 enabled/mode，再经实例身份绑定的内部宿主接口请求 policy/status/resume/permissions/authorize/pause/end/release-sessions。切换后端前释放旧会话，新目标只恢复自身策略；操作在途时切换被拒绝。损坏、未知版本或不可读设置默认关闭并展示恢复提示，原文件保留；设置写入失败不会扩大服务权限。authorize 显式传 taskId、pid、windowId、mode，服务再次验证 Task 和当前系统窗口。系统权限请求必须指定 permission=screenRecording 或 accessibility，驱动和宿主均验证该值，不提供申请全部权限的操作。宿主在请求后重新查询实际状态；未获准时只打开该项系统设置。开启或恢复策略只读取最新系统状态，两项权限及必要输入事件未齐全则拒绝，不能通过可信 IPC 绕过界面禁用状态；该操作不会申请系统权限。暂停/退出的意图优先于尚未完成的授权，延迟回包不会重新赋权。

## 实现与验证

窗口选择和发现请求在 HTTP 接入时固定当前控制版本。即使请求体尚未收完，期间发生任务停止、人工暂停或策略关闭，旧请求也不能因随后恢复访问而重新生效；需在恢复后重新发起请求。拒绝发生在原生驱动调用前，不改变恢复后的会话。

`test/computer-policy-races.test.js` 使用真实 Dashboard HTTP 和隔离驱动，覆盖重复关闭时取消旧单窗口在途/排队输入、迟到授权拒绝、关闭策略下的显式单窗口恢复，以及首次选择校验延迟时持有任务继续选窗、其他任务按 FIFO 接续。

- [持久策略](../desktop/computer-policy.cjs)、[可信宿主](../desktop/main.cjs)：默认关闭、私有原子存储、IPC 和迟到意图保护。
- [会话与队列](../src/gui/computer-use.ts)：任务独占、全局续期、暂停/取消、单次观察及活动记录。
- [辅助功能合同与等待条件](../src/gui/accessibility.ts)：有界树、观察绑定控件、匹配条件及不完整观察的缺失判定。
- [Mac 驱动](../src/gui/macos-driver.ts)、[原生 helper](../src/gui/macos-helper.swift)：独立受信进程、ScreenCaptureKit 单窗口 PNG、窗口限定 AX 文本、窗口编号明确的 AppKit 鼠标事件转 CGEvent 定向投递、Unicode 小段投递与焦点复核；没有 shell 拼接。
- [HTTP](../src/dashboard/computer-routes.ts)、[工具](../.pi/runtime/tools/computer-use.ts)、[界面](../web/assets/controllers/computer-use.js)：接口消费者；通用工作台文档协议保持兼容。

`npm run build` 在 Mac 用 Xcode Command Line Tools 编译 helper，Linux 跳过；`npm run build:computer-use` 可单独编译。二进制随 `dist/src/gui/` 进入安装包。`COWORK_COMPUTER_USE_EXECUTABLE` 仅供受信宿主配置替代驱动，不能由模型参数指定。macOS 13 可查询 helper 状态，但截图明确要求 14+。

`test/computer-global.test.js` 覆盖全局默认关闭、FIFO 流程互斥、持有者切换窗口、续期校验、暂停/取消与旧 ID 拒绝。

`test/desktop-computer-policy.test.js` 覆盖私有策略的重启、模式、损坏与版本恢复，以及分项系统权限申请、开启/恢复门槛、失败和迟到响应撤销。`e2e/computer-settings-desktop.spec.js` 在真实 Electron IPC/HTTP 链路中用隔离驱动覆盖分项允许、拒绝、可信 IPC 门槛、超过 20 秒的系统确认等待和重启不重复申请；本机身份确认通过后端进程内依赖注入模拟，真实系统确认单独验收。

`test/computer-use.test.js` 覆盖任务/目标/模式、过期、暂停与授权竞争、排队、旧观察、失败不重复投递、操作后反馈及不消耗观察的预览。`test/computer-http.test.js` 覆盖真实本机 API、跨任务授权和反馈图片传递；真实 Pi 协议用例覆盖 legacy/global 两条真实 Pi→HTTP→隔离驱动链路，包括全局启用、发现、选择、超过五分钟的测试时钟续期、连续使用操作后 observationId、交还及全局关闭。测试时钟不代表真实五分钟原生输入已验收。

`test/computer-native.test.js` 编译临时隔离 App，验证 PNG、控件点击、全选、长中文/Emoji、多行输入、按钮保存后文件重读、移动后旧输入/同应用错误窗口拒绝及接管；未授权、非 Mac、锁屏或安全键盘输入时明确跳过，不申请权限或绕过锁屏。

浏览器测试覆盖设置里的三个按钮、权限门槛、固定 control 全开、草稿保留、控制任务、恢复、关闭、迟到设置回包、写入失败，以及 Web 无法授权、窄屏/键盘焦点、断连接管和系统权限提示。

[Electron 设置回归](../e2e/computer-settings-desktop.spec.js) 使用独立数据、mock 钥匙串及隔离驱动，验证真实可信 IPC/HTTP 的跨窗口观察和输入、重启保留、旧凭据拒绝及关闭后排队请求撤销。打包 smoke 通过桌面授权观察自身窗口，并让真实 Pi 进程消费观察；系统权限、可见窗口或解锁条件不足时该原生分支明确跳过。

`test/computer-accessibility.test.js` 验证控件 ID 作用域、安全文本遮蔽、只观察/禁用/不支持动作拒绝、文字与控件条件、超时/取消/接管、不完整观察不能证明不存在、驱动树边界与不确定投递不能重发。HTTP 回归增加投递后连接丢失的 unknown；真实 Pi 回归消费 wait 新观察并执行 press/set_value。原生隔离窗口回归新增 AXSetValue/AXPress 后保存文件复核，及同路径同名同值控件被替换后拒绝旧身份；依赖已有系统权限，未实际执行时不能宣称这些原生行为已验收。

锁屏跳过不等于真实输入验收通过。公开发布仍需要解锁桌面上的完整输入回归、干净机器权限流程、安装包签名/公证及真实视觉模型验收。
