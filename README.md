# MyScholar

在论文标题旁显示期刊信息、开放指标、收录状态和期刊分级标签的浏览器油猴脚本。

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开脚本管理器，选择「添加新脚本」。
3. 清空示例内容，把 [myScholar.user.js](./myScholar.user.js) 全文粘贴进去并保存。
4. 通过扩展图标菜单中的「`MyScholar：设置`」完成首次配置。


## 支持的网站

默认在以下站点使用专用适配器：Google Scholar、PubMed、Semantic Scholar、arXiv、CNKI、百度学术、Web of Science、ScienceDirect、Nature、Springer、Wiley、IEEE、DBLP。

其他出版社网站可以在「网站范围」里按域名自行添加，或开启「任意 HTTPS 论文详情页结构化 DOI 自动识别」（默认关闭）。

## 使用

打开支持的论文页面，标签会自动出现在标题下方。鼠标悬停查看来源，点击展开完整匹配依据、年份和口径说明。

## 配置

### 网站范围

设置页「网站范围」按三层顺序判定：

1. 内置学术网站适配器（默认启用）。
2. 自定义网站，一行一个精确域名（不需要 `https://` 和路径，不支持 `*` 通配符）：
   ```text
   pubsonline.informs.org
   journals.sagepub.com
   ```
   设置页提供「添加当前网站 / 移除当前网站」快捷按钮。
3. 任意 HTTPS 论文详情页结构化 DOI 自动识别（默认关闭）。

未命中前两类、且第三类仍为关闭状态的网站，脚本不会扫描页面、注入元素或发起网络请求。

### 标签显示

在「标签显示」中逐项启用或隐藏需要的标签（期刊、DOAJ、CWTS Core、OA、PubMed、MEDLINE、PMC、NPI、EasyScholar 等级、本地数据字段等）。隐藏的项目不会出现在标题旁、`+N` 计数或详情面板中。

### 数据源

以下默认开放数据源无需密钥：

- **Crossref**：DOI 与期刊匹配；
- **OpenAlex**：DOAJ、CWTS Core、OA 和被引指标（可在官网申请免费 API Key 填入以获得更稳定的额度）；
- **NLM Catalog**（默认关闭）：按 ISSN 判定 MEDLINE 当前收录与 PMC 期刊列表。

需要 JCR/SCI、分区、CSSCI 等分级数据时：

- 在「数据源」填入你自己的 [EasyScholar Open API](https://www.easyscholar.cc/console/user/open) Secret Key（仅保存在该脚本的本地存储中，只发送给 `www.easyscholar.cc`）；或
- 在「本地数据」导入你合法拥有的 JSON/CSV 文件（只按 ISSN 或规范化期刊名匹配）。

### 挪威 NPI 等级

在「数据源」中开启后，首次使用时会下载官方当前 CSV 并按 ISSN 匹配 L2 / L1 / L0 / X，默认缓存 30 天。

## License

MIT
