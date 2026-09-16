# Excel 模板引擎与命令行验证

## 当前实现

模板引擎直接读取 `.xlsx/.xlsm` 的 OOXML 压缩包。它会读取工作簿关系、工作表 XML、样式表、Drawing、WPS `cellimages.xml`、媒体文件和关系文件。

当前支持：

- 同时检查“命名-公式”“A条码参考”“国内命名表”。
- 自动识别“命名-公式”中全部可见业务模板。
- 统计每张工作表的使用范围、公式、样式单元格、行数、自定义行高、列定义和 Drawing 引用。
- 识别普通浮动图片以及 WPS `DISPIMG/cellimages.xml` 单元格图片。
- 为工作表、样式、Drawing、媒体和关系文件分别建立结构指纹。
- 用二进制复制创建任务副本，禁止覆盖源文件或现有目标文件。
- 同时比较整文件 SHA-256 与各 OOXML 组件指纹；任何一项不一致即验证失败。
- 从每个模板的表头和公式分布识别条码名、图片、颜色、系列名、系列码、产品码、图案名和图档名。
- 为 11 个模板生成版本化 JSON 配置，区分普通可写字段、公式字段和只读字段。
- 受控写入只接受配置白名单字段；拒绝覆盖公式、图片列、未知单元格、源文件或已有目标文件。
- 写入后比较 XLSX 包内差异，并复核公式、样式、行列尺寸、图片定义、媒体和关系文件。

## 编译命令行工具

在 `casebang-desktop` 目录执行：

```powershell
pnpm build:cli
```

## 扫描三个基础表

```powershell
node out/cli/excel-engine.cjs inspect-base `
  --naming-formula "../表格文件/命名-公式(1).xlsx" `
  --barcode-reference "../表格文件/A条码参考-260116(1).xlsx" `
  --domestic-naming "../表格文件/国内命名-260407(1).xlsx" `
  --report "../output/excel-engine/基础表扫描报告.json"
```

## 建立副本并验证

```powershell
node out/cli/excel-engine.cjs clone-verify `
  --source "../表格文件/命名-公式(1).xlsx" `
  --destination "../output/excel-engine/验证副本/命名-公式(1)-精确副本.xlsx" `
  --report "../output/excel-engine/验证副本/命名-公式复制验证报告.json"
```

目标文件已存在时命令会失败，这是为了防止无意覆盖。

## 重新验证已经存在的副本

```powershell
node out/cli/excel-engine.cjs verify-existing `
  --source "../表格文件/命名-公式(1).xlsx" `
  --copy "../output/excel-engine/验证副本/命名-公式(1)-精确副本.xlsx" `
  --report "../output/excel-engine/验证副本/命名-公式命令行复验报告.json"
```

## 生成模板字段配置

```powershell
node out/cli/excel-engine.cjs generate-config `
  --source "../表格文件/命名-公式(1).xlsx" `
  --output "../output/excel-engine/命名公式模板配置.json"
```

配置记录每张模板表的表头行、OOXML 路径、字段所在列、首个公式样本、写入模式和告警。源文件 SHA-256 也会写入配置；基础表一旦更新，旧配置不能继续写入，必须重新生成。

## 按白名单受控写入

写入计划示例：

```json
{
  "sheetName": "可拆卸+其他",
  "rows": [
    {
      "row": 2,
      "values": {
        "seriesName": "Hangzhou Limited Series",
        "seriesCode": "J5系列",
        "productCode": "ZJBG00331",
        "patternName": "West Lake Lotus Charm"
      }
    }
  ]
}
```

执行命令：

```powershell
node out/cli/excel-engine.cjs controlled-write `
  --source "../表格文件/命名-公式(1).xlsx" `
  --destination "../output/excel-engine/新建表.xlsx" `
  --config "../output/excel-engine/命名公式模板配置.json" `
  --changes "../output/excel-engine/写入计划.json" `
  --report "../output/excel-engine/受控写入报告.json"
```

当前版本只写入模板中已经存在的单元格，暂不自动扩展行。公式缓存不直接改写，Excel/WPS 打开文件后按原公式重新计算。

## 本次真实扫描结果

- 命名-公式：11 个工作表、162 个公式、48 个媒体文件、51 个图片定义。
- A条码参考：32 个工作表、146 个公式、145 个媒体文件、146 个图片定义。
- 国内命名表：4 个工作表、677 个公式、1076 个媒体文件、1077 个图片定义。
- 从命名-公式识别出 11 个业务模板。
- 验证副本的整文件 SHA-256、工作表、样式、行列结构、图片定义、媒体和关系文件均与源文件一致。

## 当前边界

这一阶段已经完成“无损读取、模板字段识别、配置生成、普通单元格受控写入和写后验证”。下一阶段将增加安全扩展模板行、删除旧图片/颜色、插入裁剪后的新图片，并继续沿用同一套白名单和包级完整性验证。
