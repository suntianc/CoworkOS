# 视觉观察工具

本专项指南为中文，描述现行图片观察接口；工具由 [图片模块](../src/tools/read-image.ts) 统一供 Main 扩展与委派 PiSession 使用。原生窗口授权和动作见 [Computer Use](computer-use.md)。

| 工具          | 用途                                   | 核心参数                                                                       |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `read_image`  | 看本地图片、有序比较，或重读已归档图片 | `paths: ["before.png", "after.png"]`，1–4 张；兼容单图 `path`；或用 `imageRef` |
| `read_images` | 同一次返回多张图片，方便比较           | `images: [{path, scope}, {imageRef}]`，1–4 张                                  |
| `crop_image`  | 从已有 PNG 截图裁剪局部并放大          | `path` / `imageRef`；`region: {x,y,width,height}`；`scale`                     |
| `list_images` | 找到本 Task 最近归档图片               | `limit`，默认 20，最大 50                                                      |

Main 的路径默认相对项目目录 (`scope: "project"`)，委派 Agent 相对自己的工作目录 (`scope: "work"`)；两者均可读共享 Task (`scope: "task"`)；也接受选定作用域目录内的绝对路径，先解析真实路径，再经过原有边界检查。`imageRef` 始终属于当前 Task，不能跨 Task 使用。文件路径拒绝越界与指向外部的符号链接。

`read_image` 的 `paths` 与单图别名 `path` 可二选一；同时传入时仅允许 `path` 与 `paths: [path]` 完全一致，并且只读一次。未使用的 `paths` 可以省略或设为空数组；全空白数组按未使用处理，但不能在有效的多图列表中夹入空路径。图片文件选择与 `imageRef` 不能同时指定。

`crop_image` 和 `read_images` 的每项要求 `path` / `imageRef` 恰好一个非空来源。未用的 `path` / `imageRef` 可省略、设为 `null` 或空字符串；仅空白字符串也按未指定处理。两个非空来源同时出现仍报错，不会优先选择其中一个。Main 与委派 Pi 共用相同参数 schema。

## 局部截图与坐标

`crop_image` 裁剪已有图片，保持截图当时的画面。首批支持 PNG；JPEG、GIF、WebP 可以原图读取。区域坐标是原图 PNG 像素，x/y 为非负整数，宽高为正整数，必须完全位于图内。`scale` 为 0.25–8，默认 1，采用 nearest-neighbor 缩放，保持 UI 像素边缘。

```javascript
crop_image({
  imageRef: "img_<先前返回的 UUID>",
  region: { x: 100, y: 60, width: 300, height: 180 },
  scale: 2
});
```

返回图片、尺寸、`imageRef` 及 `mapping`：原图引用/尺寸、裁剪区域、实际 `scaleX` / `scaleY`。输出尺寸四舍五入后，两个实际比例可能不同于请求比例。位置映射为 `sourceX = region.x + outputX / scaleX`、`sourceY = region.y + outputY / scaleY`；nearest-neighbor 像素采样取映射的整数下界。嵌套裁剪的 mapping 指向直接父图，可逐层追溯。

**图片引用和 mapping 只供观察。** 它们不包含当前动作授权，不延长窗口观察的有效期。点击前仍需获取当前窗口的有效观察，并按原生工具的 `observationId` / 目标校验执行。历史来源中的 `sourceObservationId` 标记为 `historical: true`，不能复用为当前动作凭据。

## 归档、模型与限制

路径图片首次读取/裁剪时进入 `<Task>/visual/images/`，每次路径读取创建独立记录；引用重读不会复制记录。文件为不可变 `.data` 与版本 1 `.json`，记录 hash、MIME、字节数、PNG 尺寸、时间与来源。完整元数据写入 `.pending` 后原子发布，写入和列表使用跨进程锁；中断留下的 pending 不出现在历史，但残留字节继续计入预算，不自动删除历史。读取验证 hash/尺寸/普通文件边界，损坏数据报错并保留。

Main 的 `computer_observe`、`computer_wait` 与 `computer_act` 后续观察也会归档截图，返回 `imageRef` 供这些工具直接使用。归档失败不会隐藏当前截图或改写动作投递状态，反馈附 `imageArchive.saved=false` 和错误；已发送输入仍须核对实际效果。

默认限制为每图 20 MiB；`read_image(paths)` 合计 20 MiB，`read_images(images)` 合计 40 MiB；PNG 输入/输出各不超过 16M 像素；每 Task 归档最多 512 MiB / 1024 张。归档限额包含 metadata 和中断残留，达到限额拒绝新写入，已有 `imageRef` 仍可读取。跟随 Task 数据备份，暂无自动回收或降级迁移。

支持图片输入的模型直接得到按传入顺序排列的图片 blocks；连接不支持图片输入时像素不发送，读图工具明确说明当前模型不支持图片。三个读图工具都接受 `goal` 与 `review`；`review: true` 仅接受单张图片，便于逐页检查最终产物。调用取消停止后续读写/模型请求；文件读写和图片解码都受上述尺寸限制，跨进程归档锁最多等待 1 秒。

回归见 [真实像素/边界](../test/visual-observation.test.js) 与 [真实 Main/委派 Pi 工具链](../test/visual-observation-pi.test.js)。它们使用本地假模型，不替代实际多模态模型的识别质量或原生屏幕权限验收。
