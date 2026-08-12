# MyScholar 期刊标签油猴脚本

MyScholar 会在论文标题下方自动补充期刊名、开放指标、收录状态和用户有权使用的期刊分级数据。交互方式类似常见的学术浏览器扩展，但代码、视觉和数据链路均为独立实现。

当前版本为 **0.3.0**。本版本把“脚本可以在哪些网站工作”改为显式可控：内置适配器优先，用户可以另外添加出版社域名，也可以自行决定是否开启全 HTTPS 网页的结构化 DOI 自动识别。

它默认不伪造或混用评价概念：`OpenAlex 2 年平均被引`不会写成 JIF，`CWTS Core`不会写成 Web of Science Core，单篇论文进入 PubMed 也不会自动写成期刊被 MEDLINE 收录。

## 已实现

- DOI 优先；无 DOI 时以 Crossref 题名检索，并做严格的规范化题名相似度校验。
- 在标题下显示紧凑、可换行的标签；悬停可看来源，点击可看完整匹配依据、年份和口径说明。
- 可在设置中逐项选择标题旁及详情面板显示哪些标签；EasyScholar 自定义等级和本地字段也会自动加入选择列表。
- 可在“网站范围”中添加精确域名；未命中内置适配器、自定义规则或用户主动开启的自动规则时，未知网站默认不扫描论文、不注入页面元素、也不发起网络请求。
- 可选的“全网页结构化 DOI 自动识别”默认关闭；开启后也只读取与论文标题绑定的结构化 DOI 信号，不扫描正文和参考文献中的裸 DOI。
- 默认开放链路：Crossref → OpenAlex；NLM Catalog 为默认关闭的可选查询。
- 可选数据源：
  - 用户自己的 EasyScholar Open API Secret Key；
  - 挪威官方 NPI Level 0/1/2/X；
  - 用户本地导入的 JSON/CSV 数据。
- 支持动态加载、无限滚动和 SPA 结果追加，使用请求缓存和 DOM 去重。
- 不可靠匹配默认静默消失，不用“未查询到”推断“未收录”。
- 所有远端文本均用 `textContent` 渲染；请求域名采用固定白名单。

当前适配：

- Google Scholar（搜索结果、作者页）
- PubMed（搜索结果、单篇页面）
- Semantic Scholar
- arXiv
- CNKI
- 百度学术
- Web of Science
- ScienceDirect
- Nature
- Springer
- Wiley Online Library
- IEEE Xplore
- DBLP

站点 DOM 会变化。Google Scholar 风格夹具已做自动动态加载和真实浏览器回归；上述网站使用独立适配器，改版后可在 `SITE_ADAPTERS` 中更新选择器。内置适配器始终优先于通用 DOI 识别，以保留站点特有的标题、期刊和结果卡片边界。

## 安装

1. 在浏览器安装 Tampermonkey 或 Violentmonkey。
2. 打开脚本管理器，选择“添加新脚本”。
3. 删除编辑器中的示例内容，把 [myScholar.user.js](./myScholar.user.js) 全部复制进去并保存。
4. 打开任意 HTTPS 页面；需要配置时，点击 Tampermonkey/Violentmonkey 扩展图标，再选择“`MyScholar：设置`”。脚本不会在网页右下角添加悬浮按钮，未知网站在默认设置下也不会自动标注。

脚本为零构建单文件，不需要 `npm install`。

## 首次配置

### 1. 网站范围

从油猴扩展菜单进入“`MyScholar：设置` → `网站范围`”。0.3.0 提供三层激活规则，按以下顺序判断：

1. **内置学术网站适配器**：默认启用，优先使用 Google Scholar、PubMed、Web of Science、ScienceDirect 等站点的专用规则。
2. **用户自定义网站**：仅在域名命中本地规则时使用通用 DOI 识别。
3. **任意 HTTPS 论文详情页的结构化 DOI 自动识别**：默认关闭，只有用户主动开启后才会应用于未命中前两类规则的网站。

“使用通用 DOI 识别的自定义网站”支持一行一个域名：

```text
pubsonline.informs.org
journals.sagepub.com
```

- `pubsonline.informs.org`、`journals.sagepub.com` 是精确域名规则，可分别用于 INFORMS PubsOnline 和 SAGE Journals；
- 规则只匹配该精确主机名；为避免把共享托管域误授权给无关网站，脚本不接受 `*` 通配符，需要多个子域时请逐行添加；
- 只需填写域名，不需要协议、路径或查询参数；设置页也提供“添加当前网站/移除当前网站”按钮。

自定义网站会优先读取页面头部的 `publication_doi`、`citation_doi`、DC/PRISM 元数据或论文 JSON-LD，并在列表页按同一结果卡片内的 DOI 链接与标题配对。读取是只读的：不会改写出版社元数据、点击页面、提交表单或上传页面内容；导航、参考文献、引用本文、推荐内容等区域会被排除，也不会对整篇正文运行 DOI 正则扫描。

脚本元数据使用 `@match https://*/*`，目的是让用户能在新的 HTTPS 出版社网站打开设置并自行加入范围。这项页面权限不代表默认扫描所有网站。若当前域名既不是内置网站，也不匹配自定义规则，同时“全网页结构化 DOI 自动识别”仍为默认关闭状态，脚本不会扫描论文内容、不会向页面注入标签/样式/浮层、不会启动页面观察器，也不会发送任何网络请求。

如果主动开启“在任意 HTTPS 论文详情页自动识别结构化 DOI”，脚本仍要求 DOI 与标题构成页面级强信号；只在成功识别论文后查询已启用的数据源。仅在正文或参考文献中出现 DOI 不会触发标注。

### 2. 自定义标签显示

从油猴扩展菜单进入“`MyScholar：设置` → `标签显示`”，可逐项启用或隐藏：

- 期刊/出版来源、DOAJ、CWTS Core、OA、PubMed、MEDLINE、PMC、NPI 等内置标签；
- EasyScholar 返回的每一种官方等级；
- 用户 EasyScholar 账号中的自定义等级；
- 本地 JSON/CSV 中导入的每个指标字段。

旧配置和新发现的标签默认全部显示。设置页支持搜索、全部选中、全部不选和恢复默认；被隐藏的项目不会进入标题标签、`+N` 数量或详情面板的指标列表（匹配期刊、DOI 等核验上下文仍保留）。EasyScholar 自定义等级和本地字段会在脚本首次识别后加入本地标签目录，该目录只保存稳定标识、显示名称和最后发现时间，不保存指标值，也不会上传。

### 3. 默认开放数据

不配置密钥也可尝试使用：

- [Crossref REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/)：识别 DOI、正式题名、期刊名、ISSN、出版年；
- [OpenAlex API](https://developers.openalex.org/api-reference/introduction)：补充 DOAJ、CWTS Core、OA 和开放引文指标；
- [NLM Catalog](https://www.ncbi.nlm.nih.gov/books/NBK3799/)：可选；开启后按 ISSN 区分 MEDLINE 当前收录和 PMC 期刊列表。

OpenAlex 当前提供免费 API Key。建议在 [OpenAlex 设置页](https://openalex.org/settings/api) 申请后填入“数据源 → OpenAlex API Key”，以获得更稳定的额度。脚本不填写 Key 时仍会尝试有限的匿名额度。

### 4. JCR/SCI、历史中科院分区、CSSCI 等

这些数据通常没有可自由再分发的官方公共 API，因此脚本没有内置来源不明的数据库。需要这些标签时可任选一种方式：

- 在“数据源”中填入你自己的 [EasyScholar 开放 API](https://www.easyscholar.cc/console/user/open) Secret Key；
- 在“本地数据”中导入你合法持有并可使用的数据。

EasyScholar Key 由用户在脚本设置中自行填写，并通过 `GM_setValue` 持久化在该油猴脚本的隔离存储中；不会写入项目文件、论文标签、页面可见文本或控制台，也不会发送给脚本作者及其他服务。实际查询时，按照官方接口契约，它会作为 HTTPS GET 参数仅发送给 `www.easyscholar.cc`。API 未返回年份时，详情面板会明确提示自行核验版本。

脚本只从设置面板读取 Key，不会读取项目目录中的 `config.yml`、`.env` 等文件。将密钥输入框留空并保存即可清除；更换或清除后，会取消仍在排队或进行中的旧密钥请求、移除旧查询缓存，并同步其他已打开标签页。GM 存储不是系统加密钥匙串，是否参与浏览器/脚本管理器同步或备份取决于用户环境。官方当前说明 SecretKey 无法自行更改；若密钥曾以明文落盘、分享或进入版本历史，应删除这些副本并联系 EasyScholar 支持确认处置。

特别说明：中科院文献情报中心已在 2026 年 3 月宣布，自 2026 年起不再更新与发布期刊分区表；其他机构随后发布的同名分区表与其无关。参见[官方通知](https://www.las.cas.cn/news/tzgg/202603/t20260327_8178738.html)。因此脚本把相关返回标为“历史”，不会宣称存在 2026 年官方新版。

### 5. 挪威 NPI 等级

在“数据源”中开启“挪威 NPI 期刊等级”后，脚本会在本次浏览会话首次需要时下载[官方当前 CSV](https://kanalregister.hkdir.no/en/informasjonsartikler/download-current-list)，按 ISSN 匹配：

- L2：领先出版渠道；
- L1：达到学术出版最低标准；
- L0：未认可为科研出版渠道；
- X：待讨论。

它是挪威国家分类，不是 JCR 分区，也不应直接代替单篇论文质量判断。官方 CSV 约十余 MB，因此默认关闭。

## 导入本地数据

本地数据优先按 ISSN 匹配；ISSN 缺失时才按规范化期刊名精确匹配，不做宽松模糊猜测。

### JSON

```json
[
  {
    "journal": "Nature",
    "issn": ["0028-0836", "1476-4687"],
    "year": "2025",
    "source": "本单位合法授权目录",
    "metrics": {
      "JCR": "Q1",
      "本校等级": "A",
      "收录": "SCI"
    }
  }
]
```

也可把任意非身份字段直接放在记录上：

```json
{
  "journal": "Example Journal",
  "issn": "1234-567X",
  "year": "2025",
  "source": "我的目录",
  "等级": "T1"
}
```

### CSV

```csv
期刊,ISSN,年份,来源,JCR,本校等级,收录
Nature,0028-0836,2025,本单位合法授权目录,Q1,A,SCI
```

支持英文身份列 `journal,title,issn,year,version,source` 和对应中文列 `期刊,期刊名,年份,版本,来源`。其余非空列会显示为指标。

导入内容只保存在脚本管理器的本地存储中，脚本不会上传它；但用户仍需自行确认数据授权和使用范围。

## 标签的准确含义

| 标签 | 含义 | 不等同于 |
|---|---|---|
| `SCI/JCR 分区`、`影响因子` | 用户 EasyScholar API 或本地数据返回的相应字段 | 默认开放数据推导出的结果 |
| `CWTS Core` | OpenAlex `is_core` 字段 | Web of Science Core Collection |
| `DOAJ 期刊收录` | 期刊列入开放获取期刊目录 | 高影响因子、SCI 或 JCR Q 区 |
| `PubMed 论文收录` | 这篇论文出现在 PubMed 索引 | 期刊当前被 MEDLINE 收录 |
| `MEDLINE 当前收录` | NLM Catalog `currentlyindexed` 匹配 | PubMed、PMC、SCI |
| `PMC 期刊列表` | NLM Catalog `journalspmc` 匹配 | MEDLINE 或 SCI |
| `2 年平均被引` | OpenAlex source `2yr_mean_citedness` | Clarivate JIF |
| `NPI Norway L1/L2` | 挪威国家科研出版渠道等级 | JCR Q1/Q2 |

OpenAlex 自身也把 `indexed_in` 限定为其可识别的开放索引集合；脚本不会据此推断 SCI、SSCI、EI 或 Scopus。OpenAlex 字段说明见[官方 Source schema](https://developers.openalex.org/api-reference/sources)。

## 隐私和网络请求

联网前先经过网站范围和论文识别两道门槛。未知网站在默认配置下不会扫描、注入或联网；即使用户添加了自定义网站或开启全网页自动模式，也只有在取得可信的 DOI/标题后，才会按用户启用的数据源发送请求。脚本不会上传网页 HTML、正文、参考文献列表、浏览历史或当前页面 URL。

为了识别论文，脚本可能发送以下最小数据：

- DOI 或论文标题 → `api.crossref.org`；
- DOI、OpenAlex Source ID → `api.openalex.org`；
- ISSN → `eutils.ncbi.nlm.nih.gov`，仅当用户主动开启 NLM 查询；该选项默认关闭；
- 期刊名 + 用户 Secret Key → `www.easyscholar.cc/open/getPublicationRank`，仅当用户主动配置；密钥不会发送给脚本作者或其他数据源；
- 不含用户查询内容的官方整表下载 → `kanalregister.hkdir.no`，仅当主动开启 NPI。

`@match https://*/*` 只决定脚本可在哪些网页获得运行机会，不会把网络访问扩大到任意域名。所有远端请求仍使用 `GM_xmlhttpRequest` 的 `anonymous: true`，并同时受到脚本内部固定主机白名单和精确 `@connect` 域名限制；自定义的网站域名不会自动成为请求目标。Tampermonkey 的跨域权限机制可见[官方文档](https://www.tampermonkey.net/documentation.php#meta:connect)。

用户若主动开启全网页结构化 DOI 自动识别，已识别的 DOI、题名、期刊名或 ISSN 可能按照上表发送给已启用的数据源，用途仅限论文与期刊匹配。关闭该选项、移除自定义域名或关闭总开关后，该范围不再触发查询。

Crossref、NLM 和 EasyScholar 请求还使用脚本管理器共享存储做跨标签页的保守节流；EasyScholar 严格低于其官方“每秒最多 2 次”限制，遇到 HTTP `Retry-After` 时优先遵从服务端等待时间。NPI 下载使用跨标签页租约并持久缓存 30 天，以避免每页重复下载官方整表。

NLM 查询以低于 NCBI 无 Key 限额的串行速率运行，不会把用户填写的 Crossref 联系邮箱发送给 NCBI。使用 NCBI 数据与服务时须遵守其 [Disclaimer and Copyright Notice](https://www.ncbi.nlm.nih.gov/About/disclaimer.html)。

缓存策略：题名/DOI 识别约 30 天，OpenAlex work 约 14 天、source 约 45 天，NLM 约 30 天，失败结果约 1 天；最多保留约 600 项。设置面板可以随时清空缓存。

## 识别与容错

1. 先判断网站范围；内置适配器优先，自定义域名其次，全网页结构化 DOI 自动模式最后且默认关闭。
2. 通用模式只读取结构化 DOI/标题或同一论文卡片内的明确配对，并排除参考文献、引用和推荐区域。
3. 页面中能提取 DOI 时，优先做 DOI 精确查询。
4. 无 DOI 时，只有内置适配器可以继续使用 Crossref 题名检索；Crossref 返回最多 5 个期刊论文候选。
5. 脚本综合字符二元组与词集合相似度，并以约 0.84 为最低阈值；年份一致可小幅辅助，但不能挽救明显不相同的题名。
6. 无可靠匹配时默认不显示任何评价标签。
7. 异步响应写回前要求标题与结果容器仍然对应；使用题名、DOI、年份、来源和卡片身份共同去重，兼容 SPA 卡片复用。
8. API 遇到 429/5xx/超时只做有限重试，原页面功能不受影响。

arXiv 的 `10.48550/arXiv.*` 持久标识不会被当成正式期刊 DOI；脚本会转而尝试题名匹配已发表版本。

## 开发与验证

要求 Node.js 20 或兼容版本；无需安装依赖。

```bash
npm run verify
```

该命令执行：

- `node --check myScholar.user.js`
- Node 内置测试运行器的 37 组单元测试

本地浏览器夹具：

```bash
python3 -m http.server 4173 --bind 127.0.0.1
# 内置站点：
# http://127.0.0.1:4173/tests/fixtures/google-scholar.html
# 通用 DOI / 自定义网站：
# http://127.0.0.1:4173/tests/fixtures/generic-doi.html
```

夹具覆盖：

- DOI 精确匹配；
- 本地 ISSN 数据优先；
- OpenAlex、NLM 标签合并；
- 错误题名候选拒绝渲染；
- MutationObserver 动态结果；
- 标签去重、自定义显示、详情面板和油猴菜单设置入口。
- 未知站点默认零请求、在设置中加入当前域名后即时启用；
- INFORMS/SAGE 风格的 `publication_doi + dc.Title` 详情页；
- 参考文献 DOI 在发出请求前即被排除。

真实 API 冒烟测试已覆盖 Crossref DOI/题名检索、OpenAlex work/source、NLM `currentlyindexed` 和 NPI 2026 CSV 字段。

## 文件

- [`myScholar.user.js`](./myScholar.user.js)：可直接安装的单文件脚本
- [`tests/userscript.test.cjs`](./tests/userscript.test.cjs)：纯函数和数据解析测试
- [`tests/fixtures/google-scholar.html`](./tests/fixtures/google-scholar.html)：浏览器回归夹具
- [`tests/fixtures/generic-doi.html`](./tests/fixtures/generic-doi.html)：自定义网站与通用 DOI 回归夹具
- [`LICENSE`](./LICENSE)：MIT

## 已知限制

- 期刊评价体系有授权、版本和学科差异；脚本只负责展示和标注来源，不能替代正式数据库核验。
- 通用 DOI 识别依赖出版社提供规范的结构化元数据或明确的“标题—DOI”卡片关系；只有正文裸 DOI、标题缺失或卡片边界不明确的页面会保持静默。
- CNKI、百度学术、Web of Science 等页面经常改版或依赖登录，选择器可能需要后续维护。
- Crossref/OpenAlex 元数据可能缺失或录入错误；低置信度结果会给出警告，但 DOI 和出版方页面仍是最终核验依据。
- NPI 首次启用需要下载较大的官方 CSV。
- 脚本目前不内置 Clarivate、Scopus、CSSCI、北大核心、中科院历史分区等受限数据快照。

## License

MIT
