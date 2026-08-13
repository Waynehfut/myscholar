// ==UserScript==
// @name         MyScholar 期刊标签
// @namespace    https://github.com/waynehfut/myscholar
// @version      0.3.4
// @description  在学术网页的论文标题旁显示可自定义的期刊、开放指标、收录情况及用户授权的期刊分级数据。
// @author       MyScholar contributors
// @license      MIT
// @match        https://*/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @connect      www.easyscholar.cc
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '0.3.4';
  const CONFIG_KEY = 'myscholar:config:v1';
  const CACHE_KEY = 'myscholar:cache:v1';
  const LOCAL_DATA_KEY = 'myscholar:local-data:v1';
  const LABEL_CATALOG_KEY = 'myscholar:label-catalog:v1';
  const ALLOWED_REQUEST_HOSTS = new Set([
    'www.easyscholar.cc',
  ]);
  const CONTEXT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const DISTRIBUTED_GAPS = Object.freeze({
    'www.easyscholar.cc': 400,
  });

  const DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    enableKnownSites: true,
    enableDoiAnywhere: false,
    customSiteRules: [],
    easyScholarKey: '',
    easyScholarProfileId: '',
    maxBadges: 6,
    minTitleLength: 10,
    showMisses: false,
    hiddenMetricKeys: [],
  });

  const METRIC_PRIORITY = Object.freeze({
    danger: 0,
    local: 10,
    sci: 20,
    cas: 25,
    level: 30,
    index: 50,
    open: 70,
    metric: 90,
    journal: 120,
  });

  function cleanText(value) {
    return String(value ?? '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanPaperTitle(value) {
    return cleanText(value).replace(/^\s*\[(?:pdf|html|引用|书籍|b)\]\s*/i, '');
  }

  function normalizeTitle(value) {
    return cleanText(value)
      .normalize('NFKD')
      .replace(/^\s*\[(?:pdf|html|引用|书籍|b)\]\s*/i, '')
      .toLocaleLowerCase('en-US')
      .replace(/[’‘]/g, "'")
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function normalizeJournal(value) {
    return cleanText(value)
      .normalize('NFKD')
      .toLocaleLowerCase('en-US')
      .replace(/^the\s+/, '')
      .replace(/\band\b/g, '&')
      .replace(/[^\p{L}\p{N}&]+/gu, '')
      .trim();
  }

  function normalizeIssn(value) {
    const compact = cleanText(value).toUpperCase().replace(/[^0-9X]/g, '');
    return /^[0-9]{7}[0-9X]$/.test(compact)
      ? `${compact.slice(0, 4)}-${compact.slice(4)}`
      : '';
  }

  function normalizeDoi(value) {
    const text = cleanText(value)
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
      .replace(/^doi:\s*/i, '');
    const match = text.match(/10\.\d{4,9}\/[\-._;()/:A-Z0-9]+/i);
    return match ? match[0].replace(/[.,;:'"\]\)}>]+$/g, '').toLowerCase() : '';
  }

  function publicationDoi(value) {
    const doi = normalizeDoi(value);
    return /^10\.48550\/arxiv\./i.test(doi) ? '' : doi;
  }

  function extractDoi(value) {
    return normalizeDoi(value);
  }

  function normalizeSiteRule(value) {
    let text = cleanText(value).toLocaleLowerCase('en-US');
    if (!text) return '';
    if (text.startsWith('*.') || text.startsWith('.')) return '';
    try {
      const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
      if (parsed.username || parsed.password || !/^https?:$/.test(parsed.protocol)) return '';
      text = parsed.hostname;
    } catch (_) {
      return '';
    }
    text = text.replace(/^\.+|\.+$/g, '');
    if (!text || text.length > 253) return '';
    const valid = text === 'localhost'
      || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(text)
      || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(text);
    const sufficientlyScoped = text === 'localhost' || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(text) || text.includes('.');
    if (!valid || !sufficientlyScoped) return '';
    return text;
  }

  function normalizeSiteRules(value) {
    const source = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
    return [...new Set(source.map(normalizeSiteRule).filter(Boolean))].slice(0, 200);
  }

  function siteRuleMatches(hostname, rules) {
    const host = cleanText(hostname).toLocaleLowerCase('en-US').replace(/\.$/, '');
    if (!host) return false;
    return normalizeSiteRules(rules).some((rule) => {
      return host === rule;
    });
  }

  function structuredPublicationRecord(metaValues) {
    const normalized = {};
    Object.entries(metaValues && typeof metaValues === 'object' ? metaValues : {}).forEach(([key, value]) => {
      const name = cleanText(key).toLocaleLowerCase('en-US');
      const values = (Array.isArray(value) ? value : [value]).map(cleanText).filter(Boolean);
      if (name && values.length) normalized[name] = [...(normalized[name] || []), ...values];
    });
    const first = (names) => {
      for (const name of names) {
        const values = normalized[name] || [];
        for (let index = values.length - 1; index >= 0; index -= 1) {
          if (values[index]) return values[index];
        }
      }
      return '';
    };
    const doiCandidates = [
      'publication_doi', 'citation_doi', 'bepress_citation_doi', 'dc.identifier.doi', 'prism.doi', 'doi', 'dc.identifier', 'rft_id', 'og:url',
    ].flatMap((name) => [...(normalized[name] || [])].reverse());
    const doi = doiCandidates.map(publicationDoi).find(Boolean) || '';
    const title = cleanPaperTitle(first(['citation_title', 'dc.title', 'prism.title', 'og:title', 'twitter:title']));
    if (!doi || !title) return null;
    const date = first(['citation_publication_date', 'citation_date', 'prism.publicationdate', 'dc.date']);
    const yearMatch = date.match(/\b(?:19|20)\d{2}\b/);
    return {
      doi,
      title,
      journalHint: first(['citation_journal_title', 'prism.publicationname', 'dc.source']),
      year: yearMatch ? Number(yearMatch[0]) : null,
    };
  }

  function pageActivationMode(config, hostname, { known = false, structuredDoi = false } = {}) {
    if (!config?.enabled) return 'inactive';
    if (known && config.enableKnownSites !== false) return 'known';
    if (siteRuleMatches(hostname, config.customSiteRules)) return 'custom';
    if (config.enableDoiAnywhere && structuredDoi) return 'automatic';
    return 'inactive';
  }

  function hashString(value) {
    let hash = 5381;
    const text = String(value ?? '');
    for (let index = 0; index < text.length; index += 1) {
      hash = ((hash << 5) + hash) ^ text.charCodeAt(index);
    }
    return (hash >>> 0).toString(36);
  }

  function bigrams(value) {
    const text = normalizeTitle(value).replace(/\s+/g, ' ');
    if (text.length < 2) return text ? [text] : [];
    const result = [];
    for (let index = 0; index < text.length - 1; index += 1) {
      result.push(text.slice(index, index + 2));
    }
    return result;
  }

  function diceCoefficient(left, right) {
    const a = bigrams(left);
    const b = bigrams(right);
    if (!a.length || !b.length) return 0;
    const counts = new Map();
    a.forEach((item) => counts.set(item, (counts.get(item) || 0) + 1));
    let overlap = 0;
    b.forEach((item) => {
      const count = counts.get(item) || 0;
      if (count > 0) {
        overlap += 1;
        counts.set(item, count - 1);
      }
    });
    return (2 * overlap) / (a.length + b.length);
  }

  function tokenDice(left, right) {
    const a = new Set(normalizeTitle(left).split(' ').filter(Boolean));
    const b = new Set(normalizeTitle(right).split(' ').filter(Boolean));
    if (!a.size || !b.size) return 0;
    let overlap = 0;
    a.forEach((token) => {
      if (b.has(token)) overlap += 1;
    });
    return (2 * overlap) / (a.size + b.size);
  }

  function titleSimilarity(left, right) {
    const a = normalizeTitle(left);
    const b = normalizeTitle(right);
    if (!a || !b) return 0;
    if (a === b) return 1;
    return (diceCoefficient(a, b) * 0.55) + (tokenDice(a, b) * 0.45);
  }

  function isUnsafeTitleOnlyQuery(value) {
    const normalized = normalizeTitle(value);
    if (!normalized) return true;
    if (/^(?:editorial|introduction|foreword|preface|correction|erratum|retraction|letter)$/.test(normalized)) return true;
    const hasCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(normalized);
    if (hasCjk) return normalized.replace(/\s+/g, '').length < 8;
    return normalized.split(' ').filter(Boolean).length <= 2;
  }

  function parseRetryAfter(value, now = Date.now()) {
    const raw = cleanText(value);
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const dateMs = Date.parse(raw);
    return Number.isFinite(dateMs) ? Math.max(0, dateMs - now) : 0;
  }

  function easyScholarRequestUrl(secretKey, publicationName) {
    const url = new URL('https://www.easyscholar.cc/open/getPublicationRank');
    url.searchParams.set('secretKey', cleanText(secretKey));
    url.searchParams.set('publicationName', cleanText(publicationName));
    return url.toString();
  }

  function displayValue(value) {
    if (value == null) return '';
    if (Array.isArray(value)) return value.map(displayValue).filter(Boolean).join(' / ');
    if (typeof value === 'object') {
      return Object.entries(value)
        .map(([key, child]) => `${key}: ${displayValue(child)}`)
        .filter((item) => !/:\s*$/.test(item))
        .join('；');
    }
    return cleanText(value);
  }

  function inferTone(label, value) {
    const text = `${label} ${displayValue(value)}`.toUpperCase();
    if (/撤稿|RETRACT|预警|WARNING|黑名单/.test(text)) return 'danger';
    if (/(^|[^A-Z0-9])(Q1|A\+?|T1|L2)([^A-Z0-9]|$)|TOP|一区|一类|领先/.test(text)) return 'top';
    if (/(^|[^A-Z0-9])(Q2|B\+?|T2|L1)([^A-Z0-9]|$)|二区|二类/.test(text)) return 'good';
    if (/OA|DOAJ|MEDLINE|PMC|收录|CORE/.test(text)) return 'info';
    return 'neutral';
  }

  function makeMetric({
    id,
    label,
    value,
    source,
    year = '',
    note = '',
    url = '',
    tone,
    group = 'metric',
  }) {
    const shownValue = displayValue(value);
    if (!shownValue || /^(?:null|undefined|无|否|false|n\/a|-)$/i.test(shownValue)) return null;
    return {
      id: id || `${normalizeJournal(label)}:${hashString(shownValue)}`,
      label: cleanText(label),
      value: shownValue,
      source: cleanText(source),
      year: cleanText(year),
      note: cleanText(note),
      url: cleanText(url),
      tone: tone || inferTone(label, shownValue),
      group,
      priority: METRIC_PRIORITY[group] ?? METRIC_PRIORITY.metric,
    };
  }

  const EASY_FIELDS = Object.freeze({
    swufe: { label: '西南财经大学', group: 'level' },
    cqu: { label: '重庆大学', group: 'level' },
    cufe: { label: '中央财经大学', group: 'level' },
    nju: { label: '南京大学', group: 'level' },
    uibe: { label: '对外经济贸易大学', group: 'level' },
    xju: { label: '新疆大学', group: 'level' },
    sdufe: { label: '山东财经大学', group: 'level' },
    cug: { label: '中国地质大学', group: 'level' },
    xdu: { label: '西安电子科技大学', group: 'level' },
    swjtu: { label: '西南交通大学', group: 'level' },
    cju: { label: '长江大学（非计量大学）', group: 'level' },
    ruc: { label: '中国人民大学', group: 'level' },
    zju: { label: '浙江大学', group: 'level' },
    xmu: { label: '厦门大学', group: 'level' },
    sjtu: { label: '上海交通大学', group: 'level' },
    fdu: { label: '复旦大学', group: 'level' },
    hhu: { label: '河海大学', group: 'level' },
    scu: { label: '四川大学', group: 'level' },
    sciwarn: { label: '中科院预警', group: 'danger' },
    sci: { label: 'SCI/JCR 分区', group: 'sci' },
    ssci: { label: 'SSCI 分区', group: 'sci' },
    sciif: { label: '影响因子', group: 'sci' },
    sciif5: { label: '5 年影响因子', group: 'sci' },
    jci: { label: 'JCI', group: 'sci' },
    esi: { label: 'ESI 学科分类', group: 'sci' },
    sciUp: { label: '中科院升级版（历史）', group: 'cas' },
    sciUpSmall: { label: '中科院小类（历史）', group: 'cas' },
    sciUpTop: { label: '中科院 Top（历史）', group: 'cas' },
    sciBase: { label: '中科院基础版（历史）', group: 'cas' },
    ccf: { label: 'CCF', group: 'level' },
    CCF: { label: 'CCF', group: 'level' },
    pku: { label: '北大核心', group: 'index' },
    cssci: { label: 'CSSCI/南大核心', group: 'index' },
    cscd: { label: 'CSCD', group: 'index' },
    eii: { label: 'EI 检索', group: 'index' },
    ei: { label: 'EI', group: 'index' },
    ahci: { label: 'A&HCI', group: 'index' },
    zhongguokejihexin: { label: '中国科技核心', group: 'index' },
    ajg: { label: 'AJG/ABS', group: 'level' },
    fms: { label: 'FMS', group: 'level' },
    abdC: { label: 'ABDC', group: 'level' },
    abdc: { label: 'ABDC', group: 'level' },
    ft50: { label: 'FT50', group: 'level' },
    utd24: { label: 'UTD24', group: 'level' },
    cpu: { label: '中国药科大学', group: 'level' },
    xr: { label: '新锐学术', group: 'level' },
    xrWarn: { label: '新锐学术预警', group: 'danger' },
    xrTop: { label: '新锐学术 Top', group: 'level' },
    xrSmall: { label: '新锐学术小类', group: 'level' },
  });

  function parseEasyScholar(payload) {
    if (!payload || Number(payload.code) !== 200 || !payload.data) return [];
    const rank = payload.data.officialRank || {};
    const official = { ...(rank.all || {}), ...(rank.select || {}) };
    const metrics = [];
    Object.entries(EASY_FIELDS).forEach(([field, definition]) => {
      const metric = makeMetric({
        id: `easy:${field}`,
        label: definition.label,
        value: official[field],
        source: 'EasyScholar Open API（用户密钥）',
        note: definition.group === 'cas'
          ? '中科院文献情报中心已自 2026 年起停止更新与发布分区表；此处仅展示 API 返回的历史口径，API 未给出年份时请自行核验。'
          : '聚合接口返回值；版本年份未随该字段提供时，请在数据提供方核验。',
        url: 'https://www.easyscholar.cc/console/user/open',
        group: definition.group,
      });
      if (metric) metrics.push(metric);
    });

    const custom = payload.data.customRank || {};
    const infoById = new Map((custom.rankInfo || []).map((item) => [String(item.uuid), item]));
    (custom.rank || []).forEach((entry) => {
      const [uuid, level] = String(entry).split('&&&');
      const info = infoById.get(uuid);
      if (!info || !level) return;
      const label = displayValue(info.abbName || info.name || '自定义等级');
      const value = displayValue(info[`${['', 'one', 'two', 'three', 'four', 'five'][Number(level)]}RankText`] || level);
      const metric = makeMetric({
        id: `easy:custom:${uuid}`,
        label,
        value,
        source: 'EasyScholar 自定义数据集（用户密钥）',
        note: '该等级来自用户在 EasyScholar 中选择的自定义数据集。',
        group: 'level',
      });
      if (metric) metrics.push(metric);
    });
    return metrics;
  }

  function parseDelimited(text, delimiter = ',') {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    const input = String(text ?? '').replace(/^\uFEFF/, '');
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (char === '"') {
        if (quoted && input[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (char === delimiter && !quoted) {
        row.push(cell);
        cell = '';
      } else if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && input[index + 1] === '\n') index += 1;
        row.push(cell);
        if (row.some((value) => cleanText(value))) rows.push(row);
        row = [];
        cell = '';
      } else {
        cell += char;
      }
    }
    row.push(cell);
    if (row.some((value) => cleanText(value))) rows.push(row);
    return rows;
  }

  function parseIssnList(value) {
    const values = Array.isArray(value) ? value : String(value ?? '').split(/[|,;/\s]+/);
    return [...new Set(values.map(normalizeIssn).filter(Boolean))];
  }

  function localRecordFromObject(record, index) {
    if (!record || typeof record !== 'object') return null;
    const journal = cleanText(record.journal || record.title || record['期刊'] || record['期刊名']);
    const issns = parseIssnList(
      record.issns || record.issn || record.ISSN || record.eissn || record.EISSN || record.pissn || record.PISSN || record['电子ISSN'],
    );
    if (!journal && !issns.length) return null;
    const year = displayValue(record.year || record['年份'] || record.version || record['版本']);
    const source = displayValue(record.source || record['来源'] || '用户本地数据');
    const identityKeys = new Set([
      'journal', 'title', '期刊', '期刊名', 'issns', 'issn', 'ISSN', 'eissn', 'EISSN', 'pissn', 'PISSN', '电子ISSN',
      'year', '年份', 'version', '版本', 'source', '来源', 'metrics',
    ]);
    const rawMetrics = record.metrics && typeof record.metrics === 'object'
      ? record.metrics
      : Object.fromEntries(Object.entries(record).filter(([key]) => !identityKeys.has(key)));
    const metrics = [];
    Object.entries(rawMetrics).forEach(([label, value]) => {
      const metric = makeMetric({
        id: `local:${normalizeJournal(label) || hashString(label)}`,
        label,
        value,
        source,
        year,
        note: '用户在本机导入；脚本不会上传这条记录。请自行确认数据授权、年份和口径。',
        group: 'local',
      });
      if (metric) metrics.push(metric);
    });
    return { journal, issns, source, year, metrics };
  }

  function parseLocalDataset(raw) {
    const sourceText = String(raw ?? '').replace(/^\uFEFF/, '');
    const text = cleanText(sourceText);
    if (!text) return [];
    let records;
    if (text.startsWith('[') || text.startsWith('{')) {
      const parsed = JSON.parse(sourceText);
      records = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.records) ? parsed.records : [parsed]);
    } else {
      const firstLine = sourceText.split(/\r?\n/, 1)[0] || '';
      const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
      const rows = parseDelimited(sourceText, delimiter);
      const headers = (rows.shift() || []).map(cleanText);
      records = rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, cleanText(row[index])])));
    }
    return records.map(localRecordFromObject).filter(Boolean);
  }

  function indexLocalDataset(records) {
    const byIssn = new Map();
    const byJournal = new Map();
    records.forEach((record) => {
      record.issns.forEach((issn) => byIssn.set(issn, record));
      const key = normalizeJournal(record.journal);
      if (key) byJournal.set(key, record);
    });
    return { byIssn, byJournal };
  }

  function findLocalRecord(index, journal, issns) {
    for (const issn of parseIssnList(issns)) {
      if (index.byIssn.has(issn)) return { record: index.byIssn.get(issn), method: `ISSN ${issn}` };
    }
    const key = normalizeJournal(journal);
    return key && index.byJournal.has(key)
      ? { record: index.byJournal.get(key), method: '期刊名精确匹配' }
      : null;
  }

  function metricDedupe(metrics) {
    const seen = new Set();
    return (metrics || [])
      .filter(Boolean)
      .filter((metric) => {
        const key = `${normalizeJournal(metric.label)}:${normalizeJournal(metric.value)}:${normalizeJournal(metric.source)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => (left.priority - right.priority) || left.label.localeCompare(right.label, 'zh-CN'));
  }

  function dedupeDescriptors(descriptors) {
    const seenTargets = new WeakSet();
    const seenByCard = new WeakMap();
    return (Array.isArray(descriptors) ? descriptors : []).filter((descriptor) => {
      if (!descriptor?.target || typeof descriptor.target !== 'object') return false;
      if (seenTargets.has(descriptor.target)) return false;
      const card = descriptor.card && typeof descriptor.card === 'object' ? descriptor.card : descriptor.target;
      const key = `${descriptor.doi || ''}:${normalizeTitle(descriptor.title)}`;
      const cardKeys = seenByCard.get(card) || new Set();
      if (cardKeys.has(key)) return false;
      seenTargets.add(descriptor.target);
      cardKeys.add(key);
      seenByCard.set(card, cardKeys);
      return true;
    });
  }

  const EASY_FIELD_ALIASES = Object.freeze({ CCF: 'ccf', abdC: 'abdc' });
  const LABEL_GROUP_ORDER = Object.freeze([
    '基本信息',
    '风险与状态',
    'EasyScholar · JCR 与引文',
    'EasyScholar · 历史中科院分区',
    'EasyScholar · 核心与收录',
    'EasyScholar · 高校与评价目录',
    'EasyScholar · 自定义',
    '开放索引与状态',
    '医学收录',
    '其他开放指标',
    '其他分级',
    '本地数据',
    '其他已发现',
  ]);

  function canonicalEasyField(field) {
    const value = cleanText(field);
    return EASY_FIELD_ALIASES[value] || value;
  }

  function canonicalVisibilityKey(value) {
    const key = cleanText(value);
    if (!key) return '';
    const custom = key.match(/^easy:custom:([^:]+)/);
    if (custom) return `easy:custom:${custom[1]}`;
    const legacyLocal = key.match(/^local:\d+:\d+:(.+)$/);
    if (legacyLocal) return `local:${legacyLocal[1]}`;
    const easy = key.match(/^easy:(.+)$/);
    if (easy) return `easy:${canonicalEasyField(easy[1])}`;
    return key;
  }

  function metricVisibilityKey(metric) {
    if (!metric || typeof metric !== 'object') return '';
    if (metric.visibilityKey) return canonicalVisibilityKey(metric.visibilityKey);
    const id = cleanText(metric.id);
    if (/^local:/i.test(id) || metric.group === 'local') {
      return `local:${normalizeJournal(metric.label) || hashString(metric.label)}`;
    }
    return canonicalVisibilityKey(id || `metric:${normalizeJournal(metric.label)}:${hashString(metric.source)}`);
  }

  function normalizeHiddenMetricKeys(value) {
    if (!Array.isArray(value)) return [];
    const unique = new Set();
    for (const item of value) {
      const key = canonicalVisibilityKey(item);
      if (key && key.length <= 160) unique.add(key);
      if (unique.size >= 1000) break;
    }
    return [...unique];
  }

  function filterVisibleMetrics(metrics, hiddenMetricKeys) {
    const hidden = new Set(normalizeHiddenMetricKeys(
      hiddenMetricKeys instanceof Set ? [...hiddenMetricKeys] : hiddenMetricKeys,
    ));
    return (Array.isArray(metrics) ? metrics : []).filter((metric) => !hidden.has(metricVisibilityKey(metric)));
  }

  function easyLabelGroup(definition) {
    if (definition.group === 'danger') return '风险与状态';
    if (definition.group === 'sci') return 'EasyScholar · JCR 与引文';
    if (definition.group === 'cas') return 'EasyScholar · 历史中科院分区';
    if (definition.group === 'index') return 'EasyScholar · 核心与收录';
    return 'EasyScholar · 高校与评价目录';
  }

  const VISIBLE_BY_DEFAULT = Object.freeze(new Set([
    'journal:name',
    'easy:sciwarn',
    'easy:xrWarn',
    'easy:sciif',
    'easy:esi',
    'easy:sciUpTop',
    'easy:sciBase',
    'easy:sciUp',
    'easy:pku',
    'easy:zhongguokejihexin',
    'easy:cssci',
    'easy:ajg',
    'easy:ccf',
    'easy:fms',
    'easy:ft50',
    'easy:utd24',
  ]));

  function defaultHiddenGroupKeys() {
    const allKnown = [];
    FIXED_LABEL_OPTIONS.forEach((option) => {
      if (!VISIBLE_BY_DEFAULT.has(option.key)) allKnown.push(option.key);
    });
    Object.keys(EASY_FIELDS).forEach((field) => {
      const key = `easy:${canonicalEasyField(field)}`;
      if (!VISIBLE_BY_DEFAULT.has(key) && !allKnown.includes(key)) allKnown.push(key);
    });
    return allKnown;
  }

  const FIXED_LABEL_OPTIONS = Object.freeze((() => {
    const options = [
      { key: 'journal:name', label: '期刊 / 出版来源', group: '基本信息' },
    ];
    const seen = new Set(options.map((option) => option.key));
    Object.entries(EASY_FIELDS).forEach(([field, definition]) => {
      const key = `easy:${canonicalEasyField(field)}`;
      if (seen.has(key)) return;
      seen.add(key);
      options.push({ key, label: definition.label, group: easyLabelGroup(definition) });
    });
    return options.map((option) => Object.freeze(option));
  })());

  function dynamicLabelGroup(metric) {
    const key = metricVisibilityKey(metric);
    if (key.startsWith('easy:custom:')) return 'EasyScholar · 自定义';
    if (key.startsWith('local:') || metric?.group === 'local') return '本地数据';
    if (metric?.group === 'danger') return '风险与状态';
    return '其他已发现';
  }

  function normalizeLabelCatalog(saved) {
    const source = saved && typeof saved === 'object' ? saved : {};
    const normalized = {};
    Object.entries(source).forEach(([storedKey, item]) => {
      if (!item || typeof item !== 'object') return;
      const key = canonicalVisibilityKey(item.key || storedKey);
      const label = cleanText(item.label);
      if (!key || !label || key.length > 160 || label.length > 120) return;
      normalized[key] = {
        key,
        label,
        group: LABEL_GROUP_ORDER.includes(item.group) ? item.group : '其他已发现',
        lastSeen: Number(item.lastSeen) || 0,
      };
    });
    return Object.fromEntries(
      Object.entries(normalized)
        .sort(([, left], [, right]) => right.lastSeen - left.lastSeen)
        .slice(0, 300),
    );
  }

  function allMetricOptions(catalog = {}) {
    const byKey = new Map(FIXED_LABEL_OPTIONS.map((option) => [option.key, { ...option }]));
    Object.values(normalizeLabelCatalog(catalog)).forEach((option) => {
      if (!byKey.has(option.key)) byKey.set(option.key, option);
    });
    const groupRank = new Map(LABEL_GROUP_ORDER.map((group, index) => [group, index]));
    return [...byKey.values()].sort((left, right) => (
      (groupRank.get(left.group) ?? 999) - (groupRank.get(right.group) ?? 999)
      || left.label.localeCompare(right.label, 'zh-CN')
    ));
  }

  const CORE_EXPORTS = {
    cleanText,
    normalizeTitle,
    normalizeJournal,
    normalizeIssn,
    normalizeDoi,
    extractDoi,
    normalizeSiteRule,
    normalizeSiteRules,
    siteRuleMatches,
    structuredPublicationRecord,
    pageActivationMode,
    titleSimilarity,
    isUnsafeTitleOnlyQuery,
    settleWithin,
    rejectAfter,
    parseRetryAfter,
    easyScholarRequestUrl,
    isDescriptorTargetVisible,
    parseEasyScholar,
    parseDelimited,
    parseLocalDataset,
    indexLocalDataset,
    findLocalRecord,
    metricDedupe,
    dedupeDescriptors,
    makeMetric,
    canonicalVisibilityKey,
    metricVisibilityKey,
    normalizeHiddenMetricKeys,
    filterVisibleMetrics,
    normalizeLabelCatalog,
    mergeLabelCatalogs,
    allMetricOptions,
    normalizeConfig,
    isGoogleScholarHost,
    gsVenueHint,
    gsProfileVenueHint,
  };

  if (typeof document === 'undefined' && typeof module !== 'undefined' && module.exports) {
    module.exports = CORE_EXPORTS;
    return;
  }

  const state = {
    config: { ...DEFAULT_CONFIG },
    cache: {},
    cacheSaveTimer: null,
    localRaw: '',
    localIndex: indexLocalDataset([]),
    labelCatalog: {},
    labelCatalogSaveTimer: null,
    processed: new WeakMap(),
    signatureCooldowns: new Map(),
    detailById: new Map(),
    visibleObserver: null,
    mutationObserver: null,
    pageRuntimeActive: false,
    runtimeEpoch: 0,
    globalStylesAdded: false,
    scanTimer: null,
    workInFlight: new Map(),
    ui: null,
    lastUrl: location.href,
    containerRecords: new Set(),
    easyRequestHandles: new Set(),
    debugLastEasyScholar: null,
  };

  function gmGet(key, fallback) {
    try {
      return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, value);
    } catch (_) {
      // A storage failure must never break the host page.
    }
  }

  function gmDelete(key) {
    try {
      if (typeof GM_deleteValue === 'function') GM_deleteValue(key);
    } catch (_) {
      // Ignore unavailable storage implementations.
    }
  }

  function scheduleLabelCatalogSave() {
    if (state.labelCatalogSaveTimer) return;
    state.labelCatalogSaveTimer = setTimeout(() => {
      state.labelCatalogSaveTimer = null;
      const merged = mergeLabelCatalogs(gmGet(LABEL_CATALOG_KEY, {}), state.labelCatalog);
      state.labelCatalog = merged;
      gmSet(LABEL_CATALOG_KEY, merged);
    }, 250);
  }

  function mergeLabelCatalogs(...catalogs) {
    const merged = {};
    catalogs.forEach((catalog) => {
      Object.values(normalizeLabelCatalog(catalog)).forEach((item) => {
        const existing = merged[item.key];
        if (!existing || item.lastSeen >= existing.lastSeen) merged[item.key] = item;
      });
    });
    return normalizeLabelCatalog(merged);
  }

  function rememberMetricOptions(metrics) {
    const fixedKeys = new Set(FIXED_LABEL_OPTIONS.map((option) => option.key));
    let changed = false;
    for (const metric of Array.isArray(metrics) ? metrics : []) {
      const key = metricVisibilityKey(metric);
      const label = cleanText(metric?.label);
      if (!key || !label || fixedKeys.has(key)) continue;
      const existing = state.labelCatalog[key];
      const next = { key, label, group: dynamicLabelGroup(metric), lastSeen: Date.now() };
      if (!existing || existing.label !== next.label || existing.group !== next.group || next.lastSeen - existing.lastSeen > 24 * 60 * 60 * 1000) changed = true;
      state.labelCatalog[key] = next;
    }
    const pruned = normalizeLabelCatalog(state.labelCatalog);
    if (Object.keys(pruned).length !== Object.keys(state.labelCatalog).length) changed = true;
    state.labelCatalog = pruned;
    if (changed) scheduleLabelCatalogSave();
  }

  function randomLocalId() {
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function clearEasyScholarCache() {
    Object.keys(state.cache).forEach((key) => {
      if (key.startsWith('easy:')) delete state.cache[key];
    });
    scheduleCacheSave();
  }

  function easyScholarCredentialIsCurrent(key, profileId) {
    const saved = gmGet(CONFIG_KEY, {});
    return Boolean(
      key
      && profileId
      && saved
      && typeof saved === 'object'
      && cleanText(saved.easyScholarKey) === key
      && cleanText(saved.easyScholarProfileId) === profileId
    );
  }

  function abortOutstandingEasyScholarRequests() {
    for (const handle of state.easyRequestHandles) {
      try { handle.abort(); } catch (_) { /* Ignore already completed requests. */ }
    }
    state.easyRequestHandles.clear();
  }

  function distributedRateKey(scope) {
    return `myscholar:rate:${hashString(scope)}`;
  }

  async function extendDistributedCooldown(scope, delayMs) {
    if (!delayMs || typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return;
    const key = distributedRateKey(scope);
    const targetNextAt = Date.now() + Math.max(0, Number(delayMs) || 0);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = gmGet(key, null);
      if (Number(current?.nextAt || 0) >= targetNextAt) return;
      const owner = `cooldown:${CONTEXT_ID}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
      gmSet(key, {
        owner,
        nextAt: Math.max(targetNextAt, Number(current?.nextAt || 0)),
        savedAt: Date.now(),
      });
      await sleep(25 + Math.floor(Math.random() * 35));
      if (Number(gmGet(key, null)?.nextAt || 0) >= targetNextAt) return;
    }
  }

  async function acquireDistributedSlot(scope, minGapMs) {
    if (!minGapMs || typeof GM_getValue !== 'function' || typeof GM_setValue !== 'function') return;
    const key = distributedRateKey(scope);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const now = Date.now();
      const current = gmGet(key, null);
      const waitMs = Math.max(0, Number(current?.nextAt || 0) - now);
      if (waitMs > 0) {
        await sleep(waitMs + Math.floor(Math.random() * 35));
        continue;
      }
      const owner = `${CONTEXT_ID}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
      gmSet(key, { owner, nextAt: Date.now() + minGapMs, savedAt: Date.now() });
      await sleep(25 + Math.floor(Math.random() * 35));
      if (gmGet(key, null)?.owner === owner) return;
    }
    await sleep(minGapMs);
  }

  function normalizeConfig(saved) {
    const config = { ...DEFAULT_CONFIG, ...(saved && typeof saved === 'object' ? saved : {}) };
    delete config.showFloatingButton;
    config.enableKnownSites = config.enableKnownSites !== false;
    config.enableDoiAnywhere = Boolean(config.enableDoiAnywhere);
    config.customSiteRules = normalizeSiteRules(config.customSiteRules);
    config.maxBadges = Math.min(12, Math.max(1, Number(config.maxBadges) || 6));
    config.minTitleLength = Math.min(80, Math.max(5, Number(config.minTitleLength) || 10));
    const wasFresh = !Array.isArray(saved?.hiddenMetricKeys) || saved.hiddenMetricKeys.length === 0;
    config.hiddenMetricKeys = normalizeHiddenMetricKeys(config.hiddenMetricKeys);
    if (wasFresh && !config.hiddenMetricKeys.length) {
      config.hiddenMetricKeys = normalizeHiddenMetricKeys(defaultHiddenGroupKeys());
    }
    config.easyScholarKey = cleanText(config.easyScholarKey);
    const savedProfileId = cleanText(config.easyScholarProfileId);
    config.easyScholarProfileId = config.easyScholarKey
      ? (/^[a-f0-9]{32}$/i.test(savedProfileId) ? savedProfileId : randomLocalId())
      : '';
    return config;
  }

  function loadState() {
    const savedConfig = gmGet(CONFIG_KEY, {});
    state.config = normalizeConfig(savedConfig);
    if (state.config.easyScholarKey && cleanText(savedConfig?.easyScholarProfileId) !== state.config.easyScholarProfileId) {
      gmSet(CONFIG_KEY, state.config);
    } else if (!Array.isArray(savedConfig?.hiddenMetricKeys) || savedConfig.hiddenMetricKeys.length === 0) {
      const existingKeys = new Set(normalizeHiddenMetricKeys(savedConfig?.hiddenMetricKeys));
      const computed = normalizeHiddenMetricKeys(state.config.hiddenMetricKeys);
      if (computed.some((key) => !existingKeys.has(key))) {
        gmSet(CONFIG_KEY, state.config);
      }
    }
    const cached = gmGet(CACHE_KEY, {});
    state.cache = cached && typeof cached === 'object' ? cached : {};
    state.labelCatalog = normalizeLabelCatalog(gmGet(LABEL_CATALOG_KEY, {}));
    state.localRaw = String(gmGet(LOCAL_DATA_KEY, '') || '');
    try {
      const localRecords = parseLocalDataset(state.localRaw);
      state.localIndex = indexLocalDataset(localRecords);
      rememberMetricOptions(localRecords.flatMap((record) => record.metrics));
    } catch (_) {
      state.localIndex = indexLocalDataset([]);
    }
    pruneCache();
  }

  function pruneCache() {
    const now = Date.now();
    const entries = Object.entries(state.cache)
      .filter(([, entry]) => entry && Number(entry.expiresAt) > now)
      .sort(([, left], [, right]) => Number(right.savedAt || 0) - Number(left.savedAt || 0))
      .slice(0, 600);
    state.cache = Object.fromEntries(entries);
  }

  function scheduleCacheSave() {
    if (state.cacheSaveTimer) clearTimeout(state.cacheSaveTimer);
    state.cacheSaveTimer = setTimeout(() => {
      pruneCache();
      gmSet(CACHE_KEY, state.cache);
      state.cacheSaveTimer = null;
    }, 500);
  }

  async function withCache(key, positiveTtlMs, loader, negativeTtlMs = 24 * 60 * 60 * 1000) {
    const cached = state.cache[key];
    if (cached && Number(cached.expiresAt) > Date.now()) return cached.value;
    if (state.workInFlight.has(key)) return state.workInFlight.get(key);
    const promise = (async () => {
      const value = await loader();
      const ttl = value == null ? negativeTtlMs : positiveTtlMs;
      state.cache[key] = { value, expiresAt: Date.now() + ttl, savedAt: Date.now() };
      scheduleCacheSave();
      return value;
    })().finally(() => state.workInFlight.delete(key));
    state.workInFlight.set(key, promise);
    return promise;
  }

  class RateQueue {
    constructor(concurrency, minGapMs) {
      this.concurrency = concurrency;
      this.minGapMs = minGapMs;
      this.active = 0;
      this.nextStart = 0;
      this.items = [];
      this.timer = null;
    }

    add(task) {
      return new Promise((resolve, reject) => {
        this.items.push({ task, resolve, reject });
        this.pump();
      });
    }

    pump() {
      if (!this.items.length || this.active >= this.concurrency) return;
      const delay = Math.max(0, this.nextStart - Date.now());
      if (delay > 0) {
        if (!this.timer) {
          this.timer = setTimeout(() => {
            this.timer = null;
            this.pump();
          }, delay);
        }
        return;
      }
      const item = this.items.shift();
      this.active += 1;
      this.nextStart = Date.now() + this.minGapMs;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
      this.pump();
    }
  }

  const easyQueue = new RateQueue(2, 350);
  const annotationQueue = new RateQueue(3, 25);

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Optional data sources must never keep the basic journal result in the
  // loading state. Their request can finish and warm the cache later, while
  // this annotation falls back to the data already available.
  function settleWithin(promise, timeoutMs, fallback) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(fallback), Math.max(1, Number(timeoutMs) || 1));
      Promise.resolve(promise).then(finish, () => finish(fallback));
    });
  }

  function rejectAfter(promise, timeoutMs, message = '标注查询超时') {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        const error = new Error(message);
        error.timeout = true;
        finish(reject, error);
      }, Math.max(1, Number(timeoutMs) || 1));
      Promise.resolve(promise).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  async function rawRequest(url, options = {}) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !ALLOWED_REQUEST_HOSTS.has(parsed.hostname)) {
      return Promise.reject(new Error('请求域名不在白名单中'));
    }
    const gap = DISTRIBUTED_GAPS[parsed.hostname] || 0;
    const scope = parsed.hostname === 'www.easyscholar.cc'
      ? `${parsed.hostname}:${cleanText(options.easyProfileId || state.config.easyScholarProfileId) || CONTEXT_ID}`
      : parsed.hostname;
    if (options.runtimeGuard && !options.runtimeGuard()) {
      const error = new Error('页面标注范围已更改');
      error.cancelled = true;
      throw error;
    }
    if (!options.skipDistributedThrottle) await acquireDistributedSlot(scope, gap);
    if (options.runtimeGuard && !options.runtimeGuard()) {
      const error = new Error('页面标注范围已更改');
      error.cancelled = true;
      throw error;
    }
    return new Promise((resolve, reject) => {
      const request = typeof GM_xmlhttpRequest === 'function'
        ? GM_xmlhttpRequest
        : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null);
      if (!request) {
        reject(new Error('当前脚本管理器不支持跨域请求'));
        return;
      }
      const cancelledError = () => {
        const error = new Error('请求凭据已更改');
        error.cancelled = true;
        return error;
      };
      if (options.credentialGuard && !options.credentialGuard()) {
        reject(cancelledError());
        return;
      }
      let handle = null;
      const cleanup = () => {
        if (handle) state.easyRequestHandles.delete(handle);
      };
      const resolveOnce = (value) => { cleanup(); resolve(value); };
      const rejectOnce = (error) => { cleanup(); reject(error); };
      try {
        handle = request({
          method: 'GET',
          url: parsed.toString(),
          headers: { Accept: options.accept || 'application/json' },
          responseType: options.responseType || 'json',
          timeout: options.timeout || 15000,
          anonymous: parsed.hostname !== 'www.easyscholar.cc',
          onload(response) {
            if (options.credentialGuard && !options.credentialGuard()) {
              rejectOnce(cancelledError());
              return;
            }
            const status = Number(response.status || 0);
            if (status < 200 || status >= 300) {
              const error = new Error(`HTTP ${status || 'unknown'}`);
              error.status = status;
              const retryAfter = String(response.responseHeaders || '').match(/^retry-after:\s*([^\r\n]+)/im)?.[1]?.trim();
              error.retryAfterMs = parseRetryAfter(retryAfter);
              const sharedDelay = error.retryAfterMs || (status === 429 ? Math.max(1000, gap) : 0);
              if (sharedDelay && !options.skipDistributedThrottle) {
                cleanup();
                extendDistributedCooldown(scope, sharedDelay).then(() => reject(error), () => reject(error));
                return;
              }
              rejectOnce(error);
              return;
            }
            try {
              if ((options.responseType || 'json') === 'text') {
                resolveOnce(String(response.responseText ?? response.response ?? ''));
              } else if (response.response && typeof response.response === 'object') {
                resolveOnce(response.response);
              } else {
                resolveOnce(JSON.parse(response.responseText));
              }
            } catch (_) {
              rejectOnce(new Error('响应不是有效 JSON'));
            }
          },
          ontimeout() { rejectOnce(new Error('请求超时')); },
          onerror(response) {
            const detail = cleanText(response?.error) || cleanText(response?.statusText) || '';
            rejectOnce(new Error(`网络请求失败${detail ? `: ${detail}` : ''}`));
          },
          onabort() { rejectOnce(cancelledError()); },
        });
        if (options.trackEasyRequest && handle?.abort) state.easyRequestHandles.add(handle);
      } catch (error) {
        rejectOnce(error);
      }
    });
  }

  async function requestWithRetry(url, options = {}) {
    const attempts = options.attempts || 2;
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await rawRequest(url, options);
      } catch (error) {
        lastError = error;
        const retryable = !error.cancelled && (!error.status || error.status === 429 || error.status >= 500);
        if (!retryable || attempt === attempts - 1) break;
        await sleep(Math.max(700 * (2 ** attempt), Number(error.retryAfterMs || 0)));
      }
    }
    throw lastError;
  }

  async function lookupEasyScholar(journal, runtimeGuard) {
    const key = cleanText(state.config.easyScholarKey);
    const name = cleanText(journal);
    const reqUrl = easyScholarRequestUrl(key, name);
    const reqAt = Date.now();
    const storeDebug = (patch) => {
      try {
        state.debugLastEasyScholar = Object.assign({ journal: name, url: reqUrl, requestedAt: reqAt }, patch || {});
      } catch (_) { /* debug storage best-effort only */ }
    };
    if (!key || !name) {
      storeDebug({ skipped: true, skippedReason: 'missing key or name', fetchedAt: Date.now() });
      return [];
    }
    const profileId = cleanText(state.config.easyScholarProfileId);
    if (!profileId) {
      storeDebug({ skipped: true, skippedReason: 'missing profileId', fetchedAt: Date.now() });
      return [];
    }
    const credentialGuard = () => easyScholarCredentialIsCurrent(key, profileId);
    const requestGuard = () => credentialGuard() && (!runtimeGuard || runtimeGuard());
    const cacheKey = `easy:${profileId}:${hashString(normalizeJournal(name))}`;
    try {
      const result = await withCache(cacheKey, 14 * 24 * 60 * 60 * 1000, () => easyQueue.add(async () => {
        if (!requestGuard()) {
          const error = new Error('EasyScholar 密钥已更改');
          error.cancelled = true;
          throw error;
        }
        const payload = await requestWithRetry(reqUrl, {
          credentialGuard: requestGuard,
          runtimeGuard,
          easyProfileId: profileId,
          trackEasyRequest: true,
        });
        if (!requestGuard()) {
          const error = new Error('EasyScholar 密钥已更改');
          error.cancelled = true;
          throw error;
        }
        if (Number(payload?.code) !== 200) {
          const error = new Error(cleanText(payload?.msg) || `EasyScholar API code ${payload?.code ?? 'unknown'}`);
          error.status = Number(payload?.code) || 400;
          storeDebug({ fetchedAt: Date.now(), fromCache: false, code: Number(payload?.code) || 0, msg: cleanText(payload?.msg) || '', rawPayload: payload, parsedCount: 0, error: cleanText(error.message) });
          throw error;
        }
        const parsed = parseEasyScholar(payload);
        storeDebug({ fetchedAt: Date.now(), fromCache: false, code: Number(payload?.code) || 200, msg: cleanText(payload?.msg) || '', rawPayload: payload, parsedCount: parsed.length });
        return parsed;
      }));
      if (state.debugLastEasyScholar?.requestedAt !== reqAt) {
        storeDebug({ fetchedAt: Date.now(), fromCache: true, note: 'hit cache; raw payload not re-fetched', cachedResultCount: Array.isArray(result) ? result.length : 0 });
      }
      return result;
    } catch (error) {
      storeDebug({ fetchedAt: Date.now(), error: cleanText(error.message), cancelled: Boolean(error.cancelled), status: Number(error.status) || undefined });
      throw error;
    }
  }

  function findDoiInElement(element) {
    if (!element) return '';
    const attributes = [];
    if (element.getAttribute) {
      attributes.push(element.getAttribute('href'), element.getAttribute('data-doi'));
    }
    element.querySelectorAll?.('a[href], [data-doi]').forEach((node) => {
      attributes.push(node.getAttribute('href'), node.getAttribute('data-doi'));
    });
    for (const value of attributes) {
      const doi = extractDoi(value);
      if (doi) return doi;
    }
    return '';
  }

  function yearInText(value) {
    const matches = String(value ?? '').match(/\b(?:19|20)\d{2}\b/g) || [];
    const current = new Date().getFullYear() + 1;
    return matches.map(Number).find((year) => year >= 1900 && year <= current) || null;
  }

  function pageMeta(name) {
    return cleanText(document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.content);
  }

  function effectiveHostname() {
    const testHost = /^(?:localhost|127\.0\.0\.1)$/.test(location.hostname)
      && /^\/tests\/fixtures\/(?:google-scholar|generic-doi)\.html$/.test(location.pathname)
      ? normalizeSiteRule(document.documentElement.dataset.myscholarTestHost)
      : '';
    return (testHost || location.hostname).toLocaleLowerCase('en-US').replace(/^\*\./, '').replace(/\.$/, '');
  }

  function pageMetadataValues() {
    const values = {};
    document.querySelectorAll('meta[name], meta[property]').forEach((meta) => {
      const name = cleanText(meta.getAttribute('name') || meta.getAttribute('property')).toLocaleLowerCase('en-US');
      const content = cleanText(meta.getAttribute('content'));
      if (!name || !content) return;
      if (!values[name]) values[name] = [];
      values[name].push(content);
    });
    return values;
  }

  function jsonLdPublicationRecords() {
    const records = [];
    const identifiers = (value, depth = 0) => {
      if (depth > 3 || value == null) return [];
      if (typeof value === 'string' || typeof value === 'number') return [String(value)];
      if (Array.isArray(value)) return value.flatMap((item) => identifiers(item, depth + 1));
      if (typeof value !== 'object') return [];
      return ['value', '@value', 'url', 'sameAs', 'doi', 'identifier']
        .flatMap((key) => identifiers(value[key], depth + 1));
    };
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.slice(0, 50).forEach(visit);
        return;
      }
      if (node['@graph']) visit(node['@graph']);
      const types = (Array.isArray(node['@type']) ? node['@type'] : [node['@type']]).map(cleanText);
      if (!types.some((type) => /(?:article|report)$/i.test(type))) return;
      const record = structuredPublicationRecord({
        publication_doi: identifiers([node.doi, node.identifier, node.sameAs, node.url]),
        citation_title: node.headline || node.name,
        citation_publication_date: node.datePublished || node.dateCreated,
        citation_journal_title: node.isPartOf?.name || node.publication?.name,
      });
      if (record) records.push(record);
    };
    [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 20).forEach((script) => {
      const raw = script.textContent || '';
      if (!raw || raw.length > 500000) return;
      try { visit(JSON.parse(raw)); } catch (_) { /* Ignore invalid publisher JSON-LD. */ }
    });
    return records;
  }

  function currentStructuredPublication() {
    const meta = pageMetadataValues();
    if (/\/doi\//i.test(location.pathname)) {
      meta.publication_doi = [...(meta.publication_doi || []), location.href];
    }
    const metaRecord = structuredPublicationRecord(meta);
    if (metaRecord) return metaRecord;
    const records = jsonLdPublicationRecords();
    if (records.length === 1) return records[0];
    const locationDoi = /\/doi\//i.test(location.pathname) ? publicationDoi(location.href) : '';
    return locationDoi ? (records.find((record) => record.doi === locationDoi) || null) : null;
  }

  const GENERIC_EXCLUDED_CONTEXT = [
    '#references', '#reference-list', '#bibliography', '#refs',
    '.references', '.reference-list', '.ref-list', '.ref-cit', '.bibliography',
    '[class*="references__"]', '[id^="ref-"]', '[id^="reference-"]',
    '[role="doc-bibliography"]', '[role="doc-biblioentry"]',
    '[data-section-type="references"]', '[data-section-type="bibliography"]',
    '[data-section-name="references" i]', '[data-title="references" i]',
    '.core-xlink-crossref', '.citing-articles', '.related-content', '.teaser', '.content-navigation',
    'footer', 'nav', 'aside', 'pre', 'code', 'form', '[contenteditable="true"]',
  ].join(', ');

  function isExcludedGenericContext(node) {
    try {
      if (node?.closest?.(GENERIC_EXCLUDED_CONTEXT)) return true;
      let ancestor = node;
      for (let depth = 0; ancestor && ancestor !== document.body && depth < 10; depth += 1) {
        if (ancestor.matches?.('section, div, ol, ul')) {
          const heading = ancestor.querySelector?.(':scope > h1, :scope > h2, :scope > h3, :scope > header > h1, :scope > header > h2, :scope > header > h3');
          if (/^(?:references?|bibliography|literature cited|参考文献|引用文献)\s*[:：]?$/i.test(cleanText(heading?.textContent))) return true;
        }
        ancestor = ancestor.parentElement;
      }
      return false;
    } catch (_) {
      return true;
    }
  }

  function findGenericTitleTarget(expectedTitle, root = document) {
    const selectors = [
      'h1', '[role="heading"][aria-level="1"]', '[itemprop="headline"]',
      '.citation__title', '.publicationContentTitle', '.article-title', '.hlFld-Title',
      'article h2', 'main h2',
    ].join(', ');
    const candidates = [...root.querySelectorAll(selectors)]
      .filter((node) => isDescriptorTargetVisible(node) && !isExcludedGenericContext(node))
      .map((node) => ({ node, score: titleSimilarity(expectedTitle, nodeLabel(node)) }))
      .sort((left, right) => right.score - left.score);
    return candidates[0]?.score >= 0.58 ? candidates[0].node : null;
  }

  function genericDoiFromNode(node) {
    if (!node?.getAttribute) return '';
    return publicationDoi([
      node.getAttribute('data-doi'),
      node.getAttribute('href'),
      node.matches?.('input[name="doi" i]') ? node.getAttribute('value') : '',
    ].map(normalizeDoi).find(Boolean));
  }

  const GENERIC_DOI_NODE_SELECTOR = [
    'a[href*="doi.org/10." i]',
    'a[href*="/doi/" i]',
    '[data-doi]',
    'input[name="doi" i][value]',
  ].join(', ');
  const GENERIC_CARD_SELECTOR = [
    '.search__item', '.issue-item', 'article', '[itemtype*="ScholarlyArticle"]',
    '[data-article-id]', '[data-paper-id]',
    'li[class*="result" i]', 'li[class*="article" i]',
    'div[class*="result-item" i]', 'div[class*="article-item" i]',
    'tr',
  ].join(', ');

  function genericCardTitle(card, doiNode) {
    const direct = doiNode?.matches?.('a') ? nodeLabel(doiNode) : '';
    const directLooksLikeTitle = doiNode?.matches?.([
      'h1 a', 'h2 a', 'h3 a', 'h4 a',
      '[class*="title" i]', '[data-id*="title" i]', '[itemprop="headline"]',
    ].join(', '));
    if (directLooksLikeTitle && direct && !normalizeDoi(direct) && normalizeTitle(direct).length >= 10) return doiNode;
    const candidates = [...card.querySelectorAll([
      'h1', 'h2', 'h3', 'h4', '[role="heading"]', '[itemprop="headline"]',
      '.meta__title a', '.issue-item__title a', 'a[class*="title" i]', '[class*="title" i] a',
    ].join(', '))];
    return candidates.find((node) => (
      isDescriptorTargetVisible(node)
      && !isExcludedGenericContext(node)
      && !normalizeDoi(nodeLabel(node))
      && normalizeTitle(nodeLabel(node)).length >= 10
    )) || null;
  }

  function genericDoiDescriptors({ includeCardLinks = false } = {}) {
    const host = effectiveHostname();
    const site = `通用 DOI · ${host}`;
    const publication = currentStructuredPublication();
    if (publication) {
      const target = findGenericTitleTarget(publication.title);
      if (target) {
        const card = target.closest('article, main, [role="main"]') || target.parentElement;
        return [descriptorFrom(target, card, site, {
          ...publication,
          generic: true,
          doiEvidence: 'metadata',
          journalHintStrict: true,
        })];
      }
    }
    if (!includeCardLinks) return [];

    const descriptors = [];
    const seenCards = new WeakSet();
    const seenTargets = new WeakSet();
    const nodes = [...document.querySelectorAll(GENERIC_DOI_NODE_SELECTOR)].slice(0, 120);
    for (const node of nodes) {
      if (descriptors.length >= 40 || isExcludedGenericContext(node)) continue;
      const doi = genericDoiFromNode(node);
      if (!doi) continue;
      const card = node.closest(GENERIC_CARD_SELECTOR);
      if (!card || seenCards.has(card) || isExcludedGenericContext(card)) continue;
      const cardDois = new Set(
        [...card.querySelectorAll(GENERIC_DOI_NODE_SELECTOR)]
          .filter((candidate) => !isExcludedGenericContext(candidate))
          .map(genericDoiFromNode)
          .filter(Boolean),
      );
      if (cardDois.size !== 1 || !cardDois.has(doi)) continue;
      const target = genericCardTitle(card, node);
      if (!target || seenTargets.has(target)) continue;
      seenCards.add(card);
      seenTargets.add(target);
      descriptors.push(descriptorFrom(target, card, site, {
        doi,
        title: nodeLabel(target),
        generic: true,
        doiEvidence: node.hasAttribute('data-doi') ? 'data-doi' : 'link',
      }));
    }
    return descriptors;
  }

  function nodeLabel(node) {
    return cleanText(node?.getAttribute?.('title') || node?.textContent);
  }

  // 从 Google Scholar 的 .gs_a 元信息行（“作者 - 期刊, 年份 - 来源”）提取期刊/会议名；
  // 预印本行（“作者 - 2023 - arXiv”等）提取不到期刊时返回空串。
  function gsVenueHint(metaLine) {
    const text = cleanText(metaLine?.textContent || '');
    const parts = text.split(/\s+-\s+/);
    const withYear = parts.find((part) => /\b(?:19|20)\d{2}\b/.test(part));
    if (!withYear) return '';
    // 年份落在首段且后面还有其他段（如“作者, 年份 - arXiv”）时该行没有期刊段，
    // 返回空串，避免把作者名单误识别为期刊名。
    if (parts.indexOf(withYear) === 0 && parts.length > 1) return '';
    const hint = cleanText(withYear.replace(/[,;]\s*(?:19|20)\d{2}\b.*$/, ''));
    if (!hint || /^(?:19|20)\d{2}$/.test(hint)) return '';
    if (/^(?:arxiv|ssrn|preprint|medrxiv|biorxiv|research\s*gate)/i.test(hint)) return '';
    return hint;
  }

  // 从 Google Scholar 作者页每行的第二个 .gs_gray（“期刊名 卷(期), 页码, 年份”）提取期刊/会议名；
  // 预印本行（arXiv 等）返回空串；该行缺省时也不回退到作者名单，避免把姓名误当期刊。
  function gsProfileVenueHint(metaLine) {
    let text = cleanText(metaLine?.textContent || '');
    if (!text || /^(?:arxiv|ssrn|preprint|medrxiv|biorxiv|research\s*gate)/i.test(text)) return '';
    text = text.replace(/[,;]\s*(?:19|20)\d{2}\b.*$/, '');
    text = text.replace(/\s+\d+\s*\(\s*\d+\s*\)[^]*$/, '');
    text = text.replace(/[,;]\s*\d+[^]*$/, '');
    const hint = cleanText(text.replace(/[,;]+$/, ''));
    return hint && !/^(?:19|20)\d{2}$/.test(hint) ? hint : '';
  }

  function descriptorFrom(target, card, site, overrides = {}) {
    const title = cleanPaperTitle(overrides.title || target?.textContent);
    const context = cleanText(card?.textContent);
    const hasDoiOverride = Object.prototype.hasOwnProperty.call(overrides, 'doi');
    const doi = publicationDoi(hasDoiOverride ? overrides.doi : findDoiInElement(card));
    const year = overrides.year || yearInText(context);
    const journalHint = cleanText(overrides.journalHint);
    const stableCardId = cleanText([
      card?.getAttribute?.('data-paper-id'),
      card?.getAttribute?.('data-article-id'),
      card?.getAttribute?.('data-cid'),
      target?.getAttribute?.('href'),
    ].filter(Boolean).join('|'));
    return {
      target,
      card,
      site,
      title,
      doi,
      year,
      journalHint,
      journalHintStrict: Boolean(overrides.journalHintStrict),
      generic: Boolean(overrides.generic),
      doiEvidence: cleanText(overrides.doiEvidence),
      stableCardId,
      nodeSignature: hashString(normalizeTitle(target?.textContent)),
      identitySignature: hashString([
        normalizeTitle(title), doi, year || '', normalizeJournal(journalHint), stableCardId,
      ].join('|')),
    };
  }

  const SITE_ADAPTERS = [
    {
      id: 'google-scholar',
      match: isGoogleScholarHost,
      scan: () => [
        ...[...document.querySelectorAll('.gs_r .gs_rt')].map((target) => {
          const card = target.closest('.gs_r');
          return descriptorFrom(target, card, 'Google Scholar', {
            journalHint: gsVenueHint(card?.querySelector('.gs_a')),
          });
        }),
        ...[...document.querySelectorAll('#gsc_a_b tr.gsc_a_tr a.gsc_a_at')].map((target) => {
          const card = target.closest('tr.gsc_a_tr');
          // 作者页每行有两个 .gs_gray：第一个是作者名单，第二个才是期刊/会议；
          // 缺少第二个（预印本等）时返回空串，而不是把姓名识别成期刊名。
          const grayNodes = card?.querySelectorAll('.gs_gray');
          const venueNode = grayNodes && grayNodes.length > 1 ? grayNodes[grayNodes.length - 1] : null;
          return descriptorFrom(target, card, 'Google Scholar 作者页', {
            journalHint: gsProfileVenueHint(venueNode),
          });
        }),
      ],
    },
    {
      id: 'pubmed',
      match: (host) => host === 'pubmed.ncbi.nlm.nih.gov',
      scan: () => [...document.querySelectorAll('a.docsum-title, h1.heading-title')].map((target) => {
        const card = target.closest('.docsum-content, article, main') || target.parentElement;
        return descriptorFrom(target, card, 'PubMed', {
          doi: target.matches('h1') ? pageMeta('citation_doi') : findDoiInElement(card),
          journalHint: target.matches('h1')
            ? (pageMeta('citation_journal_title') || cleanText(card?.querySelector('.full-journal-citation')?.textContent).split(/[.;]/)[0])
            : cleanText(card?.querySelector('.full-journal-citation')?.textContent).split(/[.;]/)[0],
        });
      }),
    },
    {
      id: 'semantic-scholar',
      match: (host) => host === 'www.semanticscholar.org',
      scan: () => {
        const results = [...document.querySelectorAll('div.cl-paper-row[data-paper-id]')]
          .map((card) => {
            const target = card.querySelector('[data-test-id="title-link"], [data-selenium-selector="title-link"], h3.cl-paper-title');
            return target ? descriptorFrom(target, card, 'Semantic Scholar', {
              journalHint: nodeLabel(card.querySelector('.cl-paper-venue')),
            }) : null;
          })
          .filter(Boolean);
        document.querySelectorAll('h1[data-selenium-selector="paper-detail-title"], .fresh-paper-detail-page__header > h1').forEach((target) => {
          results.push(descriptorFrom(target, target.closest('main') || target.parentElement, 'Semantic Scholar', {
            doi: pageMeta('citation_doi'),
            journalHint: pageMeta('citation_journal_title'),
            journalHintStrict: true,
          }));
        });
        return results;
      },
    },
    {
      id: 'cnki',
      match: (host) => host.endsWith('.cnki.net') || host === 'cnki.net',
      scan: () => [...document.querySelectorAll('#gridTable .result-table-list a.fz14, #gridTable .result-table-list .name a, .result-item .title a, #title #chTitle, .container .brief > div > h1, .wxTitle > h2.title')]
        .map((target) => {
          const isDetail = target.matches('#title #chTitle, .container .brief > div > h1, .wxTitle > h2.title');
          const card = target.closest('tr, .result-item, li') || (isDetail ? document.querySelector('main, .container') : target.parentElement);
          return descriptorFrom(target, card, 'CNKI', {
            doi: isDetail ? pageMeta('citation_doi') : '',
            journalHint: isDetail
              ? (pageMeta('citation_journal_title') || nodeLabel(document.querySelector('.baseinfo a[href*="knavi/detail"], .top-tip-scholar span:nth-child(2) > a')))
              : nodeLabel(card?.querySelector('td.source a, td.source, .source a, .source')),
            journalHintStrict: true,
          });
        }),
    },
    {
      id: 'baidu-scholar',
      match: (host) => host === 'xueshu.baidu.com',
      scan: () => document.querySelector('#content_left, #container') ? [...document.querySelectorAll('#content_left .result h3.t a, #content_left .sc_content h3.t a, #container .main-info > h3')]
        .map((target) => {
          const isDetail = target.matches('#container .main-info > h3');
          const card = target.closest('.sc_content, .result, article') || (isDetail ? document.querySelector('#container') : target.parentElement);
          return descriptorFrom(target, card, '百度学术', {
            doi: isDetail ? pageMeta('citation_doi') : '',
            journalHint: isDetail
              ? nodeLabel(document.querySelector('#container .container_right a.journal_title'))
              : nodeLabel(card?.querySelector('.sc_info > span:nth-child(2) > a[title], .sc_info a[title]')),
            journalHintStrict: true,
          });
        }) : [],
    },
    {
      id: 'web-of-science',
      match: (host) => host === 'www.webofscience.com',
      scan: () => [...document.querySelectorAll('[data-ta="title-link"], [data-ta="summary-record-title-link"], app-summary-title a, #FullRTa-fullRecordtitle-0')]
        .map((target) => {
          const isDetail = target.matches('#FullRTa-fullRecordtitle-0');
          const card = isDetail
            ? (target.closest('app-full-record, [data-ta="full-record"], main') || target.parentElement)
            : (target.closest('app-summary-record, div.summary-record, article') || target.parentElement);
          const sourceSelector = [
            '[data-ta="source-title"]',
            '[data-ta="journal-title"]',
            'app-full-record-source-title a',
            'a.summary-source-title-link span',
            'span.summary-source-title',
          ].join(', ');
          return descriptorFrom(target, card, 'Web of Science', {
            doi: isDetail ? pageMeta('citation_doi') : findDoiInElement(card),
            journalHint: isDetail
              ? (pageMeta('citation_journal_title') || nodeLabel(card?.querySelector(sourceSelector)))
              : nodeLabel(card?.querySelector(sourceSelector)),
            journalHintStrict: true,
          });
        }),
    },
    {
      id: 'science-direct',
      match: (host) => host === 'www.sciencedirect.com',
      scan: () => [...document.querySelectorAll('a.result-list-title-link, h1.article-title, h1.content-title, h1#screen-reader-main-title')]
        .map((target) => {
          const card = target.closest('li.ResultItem, article, main') || target.parentElement;
          return descriptorFrom(target, card, 'ScienceDirect', {
            doi: target.matches('h1') ? pageMeta('citation_doi') : findDoiInElement(card),
            journalHint: target.matches('h1')
              ? pageMeta('citation_journal_title')
              : nodeLabel(card?.querySelector('a.subtype-srctitle-link, h4.srctitle-date-fields a[href], .srctitle-date-fields a[href]')),
          });
        }),
    },
    {
      id: 'nature',
      match: (host) => host === 'www.nature.com',
      scan: () => [...document.querySelectorAll('h1[data-test="article-title"], h1.c-article-title')]
        .map((target) => descriptorFrom(target, target.closest('article, main') || target.parentElement, 'Nature', {
          doi: pageMeta('citation_doi'),
          journalHint: pageMeta('citation_journal_title'),
          title: pageMeta('citation_title') || target.textContent,
        })),
    },
    {
      id: 'springer',
      match: (host) => host === 'link.springer.com',
      scan: () => [...document.querySelectorAll('h3.app-card-open__heading a.app-card-open__link, h3.c-card__title a, h1.c-article-title')]
        .map((target) => {
          const card = target.closest('li.app-card-open, .c-card, article, main') || target.parentElement;
          return descriptorFrom(target, card, 'Springer', {
            doi: target.matches('h1') ? pageMeta('citation_doi') : findDoiInElement(card),
            journalHint: target.matches('h1')
              ? pageMeta('citation_journal_title')
              : nodeLabel(card?.querySelector('a[data-test="parent"]')),
          });
        }),
    },
    {
      id: 'wiley',
      match: (host) => host === 'onlinelibrary.wiley.com',
      scan: () => [...document.querySelectorAll('a.publication_title, h1.citation__title')]
        .map((target) => {
          const card = target.closest('.item__body, article, main') || target.parentElement;
          return descriptorFrom(target, card, 'Wiley', {
            doi: target.matches('h1') ? pageMeta('citation_doi') : findDoiInElement(card),
            journalHint: target.matches('h1')
              ? pageMeta('citation_journal_title')
              : nodeLabel(card?.querySelector('a.meta__serial, .meta__serial')),
          });
        }),
    },
    {
      id: 'ieee',
      match: (host) => host === 'ieeexplore.ieee.org',
      scan: () => {
        const descriptors = [];
        // 详情页：新版 Angular 页面不再输出 citation_* meta，DOI 与期刊名从页面 DOM 提取
        document.querySelectorAll('h1.document-title').forEach((target) => {
          const card = target.closest('.List-results-items, article, main') || target.parentElement;
          descriptors.push(descriptorFrom(target, card, 'IEEE Xplore', {
            doi: pageMeta('citation_doi')
              || publicationDoi(card?.querySelector('.stats-document-abstract-doi a[href], a[href*="doi.org/10."]')?.getAttribute('href'))
              || findDoiInElement(card),
            journalHint: pageMeta('citation_journal_title')
              || nodeLabel(card?.querySelector('a.stats-document-abstract-publishedIn')),
            journalHintStrict: true,
          }));
        });
        // 列表页：新版搜索结果标题在 h3 卡片链接，期刊名在 .description 首个链接
        document.querySelectorAll('.List-results-items h3 a[href*="/document/"], h2.result-item-title a').forEach((target) => {
          const card = target.closest('.List-results-items, article, main') || target.parentElement;
          descriptors.push(descriptorFrom(target, card, 'IEEE Xplore', {
            journalHint: nodeLabel(card?.querySelector('.description a[href], a[href*="/xpl/RecentIssue.jsp"], a[href*="/xpl/conhome/"]')),
          }));
        });
        return descriptors;
      },
    },
    {
      id: 'dblp',
      match: (host) => host === 'dblp.org',
      scan: () => [...document.querySelectorAll('li.entry cite.data .title')]
        .map((target) => {
          const card = target.closest('li.entry') || target.parentElement;
          // 新版 DBLP 不再用 article 包裹 cite.data，期刊/会议名在 itemprop=isPartOf 链接里
          const venue = card?.querySelector('cite.data [itemprop="isPartOf"] [itemprop="name"], cite.data [itemprop="isPartOf"]');
          // TOC 页逐条不带期刊信息时回退到页面标题（如 “IEEE Transactions on …, Volume 38”）
          const pageHeading = cleanText(document.querySelector('#main h1')?.textContent);
          const pageVenue = /,?\s*Volume\s+\d+/i.test(pageHeading)
            ? cleanText(pageHeading.replace(/\s*,\s*Volume\s+\d+.*$/i, ''))
            : '';
          return descriptorFrom(target, card, 'DBLP', {
            journalHint: nodeLabel(venue) || pageVenue,
          });
        }),
    },
  ];

  function currentKnownAdapter() {
    const host = effectiveHostname();
    return SITE_ADAPTERS.find((adapter) => adapter.match(host));
  }

  function isGoogleScholarHost(host) {
    return new Set([
      'scholar.google.com', 'scholar.google.com.hk', 'scholar.google.co.uk',
      'scholar.google.ca', 'scholar.google.de', 'scholar.google.es',
      'scholar.google.fr', 'scholar.google.it', 'scholar.google.co.jp',
    ]).has(host);
  }

  function currentScanPlan() {
    const host = effectiveHostname();
    const knownAdapter = currentKnownAdapter();
    const custom = siteRuleMatches(host, state.config.customSiteRules);
    const needsStructuredCheck = Boolean(
      state.config.enabled
      && state.config.enableDoiAnywhere
      && !(knownAdapter && state.config.enableKnownSites !== false)
      && !custom
    );
    const structuredDoi = needsStructuredCheck ? Boolean(currentStructuredPublication()) : false;
    return {
      host,
      knownAdapter,
      isCustom: custom,
      mode: pageActivationMode(state.config, host, { known: Boolean(knownAdapter), structuredDoi }),
    };
  }

  function isDescriptorTargetVisible(target) {
    return Boolean(target?.isConnected && !target.closest?.('[hidden], [aria-hidden="true"]'));
  }

  function validDescriptor(descriptor) {
    if (!isDescriptorTargetVisible(descriptor?.target)) return false;
    if (descriptor.generic && !descriptor.doi) return false;
    const normalized = normalizeTitle(descriptor.title);
    if (normalized.length < state.config.minTitleLength) return false;
    if (descriptor.target.closest('.myscholar-badges, #myscholar-ui-host')) return false;
    return true;
  }

  function addGlobalStyles() {
    if (state.globalStylesAdded) return;
    const css = `
      .myscholar-badges { display:flex !important; flex-wrap:wrap !important; align-items:center !important; gap:4px !important; margin:5px 0 3px !important; max-width:100% !important; font:500 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif !important; color-scheme:light dark !important; }
      .myscholar-badges--empty { display:none !important; }
      .myscholar-badge { appearance:none !important; box-sizing:border-box !important; display:inline-flex !important; align-items:center !important; gap:3px !important; max-width:240px !important; min-height:22px !important; margin:0 !important; padding:2px 7px !important; border:1px solid #cbd5e1 !important; border-radius:999px !important; background:#f8fafc !important; color:#334155 !important; font:inherit !important; text-decoration:none !important; vertical-align:middle !important; cursor:pointer !important; box-shadow:none !important; overflow:hidden !important; white-space:nowrap !important; }
      .myscholar-badge:hover, .myscholar-badge:focus-visible { border-color:#64748b !important; outline:2px solid rgba(59,130,246,.32) !important; outline-offset:1px !important; }
      .myscholar-badge__label { opacity:.76 !important; flex:none !important; }
      .myscholar-badge--label-only .myscholar-badge__label { opacity:1 !important; font-weight:700 !important; }
      .myscholar-badge__value { overflow:hidden !important; text-overflow:ellipsis !important; font-weight:700 !important; }
      .myscholar-badge--tone-danger { color:#991b1b !important; background:#fef2f2 !important; border-color:#fca5a5 !important; }
      /* index: DOAJ/CWTS/MEDLINE/PMC/CSSCI/北大核心 等收录类 — 翡翠绿 (Color Hunt #1B5E20 #66BB6A #A5D6A7 #E8F5E9) */
      .myscholar-badge--group-index.myscholar-badge--tone-top { color:#14532d !important; background:#dcfce7 !important; border-color:#4ade80 !important; }
      .myscholar-badge--group-index.myscholar-badge--tone-good { color:#166534 !important; background:#f0fdf4 !important; border-color:#86efac !important; }
      .myscholar-badge--group-index.myscholar-badge--tone-info { color:#15803d !important; background:#ecfdf5 !important; border-color:#bbf7d0 !important; }
      .myscholar-badge--group-index.myscholar-badge--tone-neutral { color:#166534 !important; background:#f0fdfa !important; border-color:#bbf7d0 !important; }
      /* sci: SCI/JCR/SSCI/IF/JCI/ESI — 皇家蓝 (Color Hunt #0D47A1 #2196F3 #90CAF9 #E3F2FD) */
      .myscholar-badge--group-sci.myscholar-badge--tone-top { color:#1e3a8a !important; background:#dbeafe !important; border-color:#60a5fa !important; }
      .myscholar-badge--group-sci.myscholar-badge--tone-good { color:#1d4ed8 !important; background:#eff6ff !important; border-color:#93c5fd !important; }
      .myscholar-badge--group-sci.myscholar-badge--tone-info { color:#1e40af !important; background:#f0f9ff !important; border-color:#bfdbfe !important; }
      .myscholar-badge--group-sci.myscholar-badge--tone-neutral { color:#1e3a8a !important; background:#f8fafc !important; border-color:#e0f2fe !important; }
      /* cas: 中科院分区系列 — 琥珀橙 (Color Hunt #C62828 #FF8F00 #FBC02D #F5F5DC) */
      .myscholar-badge--group-cas.myscholar-badge--tone-top { color:#7c2d12 !important; background:#ffedd5 !important; border-color:#fb923c !important; }
      .myscholar-badge--group-cas.myscholar-badge--tone-good { color:#9a3412 !important; background:#fff7ed !important; border-color:#fdba74 !important; }
      .myscholar-badge--group-cas.myscholar-badge--tone-info { color:#b45309 !important; background:#fffbeb !important; border-color:#fed7aa !important; }
      .myscholar-badge--group-cas.myscholar-badge--tone-neutral { color:#78350f !important; background:#fefce8 !important; border-color:#fde68a !important; }
      /* level: 本校等级/CCF/ABDC/FMS/FT50 等分级类 — 紫罗兰 (Color Hunt #98E8DE #45A9A9 #3E3E75 #4E1F6E) */
      .myscholar-badge--group-level.myscholar-badge--tone-top { color:#581c87 !important; background:#faf5ff !important; border-color:#c084fc !important; }
      .myscholar-badge--group-level.myscholar-badge--tone-good { color:#6d28d9 !important; background:#f5f3ff !important; border-color:#c4b5fd !important; }
      .myscholar-badge--group-level.myscholar-badge--tone-info { color:#7e22ce !important; background:#fdf4ff !important; border-color:#e9d5ff !important; }
      .myscholar-badge--group-level.myscholar-badge--tone-neutral { color:#6b21a8 !important; background:#fafaf9 !important; border-color:#f3e8ff !important; }
      /* open: OA 期刊 / arXiv 等开放类 — 水青 (Color Hunt 青色系 #134E4A #0F766E #2DD4BF #F0FDFA) */
      .myscholar-badge--group-open.myscholar-badge--tone-top { color:#115e59 !important; background:#ccfbf1 !important; border-color:#2dd4bf !important; }
      .myscholar-badge--group-open.myscholar-badge--tone-good { color:#0f766e !important; background:#f0fdfa !important; border-color:#5eead4 !important; }
      .myscholar-badge--group-open.myscholar-badge--tone-info { color:#0f766e !important; background:#ecfeff !important; border-color:#99f6e4 !important; }
      .myscholar-badge--group-open.myscholar-badge--tone-neutral { color:#134e4a !important; background:#f0fdfa !important; border-color:#99f6e4 !important; }
      /* local: 用户本地 JSON/CSV 导入数据 — 赭石/暖沙 (Color Hunt #FDF0D5 #E9C46A #E76F51 #249D8F) */
      .myscholar-badge--group-local.myscholar-badge--tone-top { color:#7c2d12 !important; background:#ffedd5 !important; border-color:#e67e22 !important; }
      .myscholar-badge--group-local.myscholar-badge--tone-good { color:#9a3412 !important; background:#fff7ed !important; border-color:#f59e0b !important; }
      .myscholar-badge--group-local.myscholar-badge--tone-info { color:#92400e !important; background:#fef3c7 !important; border-color:#fcd34d !important; }
      .myscholar-badge--group-local.myscholar-badge--tone-neutral { color:#78350f !important; background:#fffbeb !important; border-color:#fde68a !important; }
      .myscholar-badge--loading { color:#64748b !important; background:transparent !important; border-style:dashed !important; cursor:default !important; animation:myscholar-pulse 1.4s ease-in-out infinite !important; }
      @keyframes myscholar-pulse { 50% { opacity:.48; } }
      @media (prefers-color-scheme:dark) {
        .myscholar-badge { background:#1e293b !important; color:#e2e8f0 !important; border-color:#475569 !important; }
        .myscholar-badge--tone-danger { background:#450a0a !important; color:#fecaca !important; border-color:#b91c1c !important; }
        .myscholar-badge--group-index.myscholar-badge--tone-top { background:#052e16 !important; color:#bbf7d0 !important; border-color:#15803d !important; }
        .myscholar-badge--group-index.myscholar-badge--tone-good { background:#052e16 !important; color:#86efac !important; border-color:#166534 !important; }
        .myscholar-badge--group-index.myscholar-badge--tone-info { background:#022c22 !important; color:#6ee7b7 !important; border-color:#065f46 !important; }
        .myscholar-badge--group-index.myscholar-badge--tone-neutral { background:#022c22 !important; color:#6ee7b7 !important; border-color:#064e3b !important; }
        .myscholar-badge--group-sci.myscholar-badge--tone-top { background:#172554 !important; color:#bfdbfe !important; border-color:#1d4ed8 !important; }
        .myscholar-badge--group-sci.myscholar-badge--tone-good { background:#172554 !important; color:#93c5fd !important; border-color:#1e40af !important; }
        .myscholar-badge--group-sci.myscholar-badge--tone-info { background:#0c4a6e !important; color:#7dd3fc !important; border-color:#0369a1 !important; }
        .myscholar-badge--group-sci.myscholar-badge--tone-neutral { background:#082f49 !important; color:#7dd3fc !important; border-color:#0369a1 !important; }
        .myscholar-badge--group-cas.myscholar-badge--tone-top { background:#431407 !important; color:#fed7aa !important; border-color:#c2410c !important; }
        .myscholar-badge--group-cas.myscholar-badge--tone-good { background:#431407 !important; color:#fdba74 !important; border-color:#9a3412 !important; }
        .myscholar-badge--group-cas.myscholar-badge--tone-info { background:#451a03 !important; color:#fcd34d !important; border-color:#b45309 !important; }
        .myscholar-badge--group-cas.myscholar-badge--tone-neutral { background:#451a03 !important; color:#fcd34d !important; border-color:#78350f !important; }
        .myscholar-badge--group-level.myscholar-badge--tone-top { background:#3b0764 !important; color:#e9d5ff !important; border-color:#7e22ce !important; }
        .myscholar-badge--group-level.myscholar-badge--tone-good { background:#3b0764 !important; color:#d8b4fe !important; border-color:#6d28d9 !important; }
        .myscholar-badge--group-level.myscholar-badge--tone-info { background:#4c1d95 !important; color:#c4b5fd !important; border-color:#581c87 !important; }
        .myscholar-badge--group-level.myscholar-badge--tone-neutral { background:#2e1065 !important; color:#c4b5fd !important; border-color:#581c87 !important; }
        .myscholar-badge--group-open.myscholar-badge--tone-top { background:#042f2e !important; color:#5eead4 !important; border-color:#0d9488 !important; }
        .myscholar-badge--group-open.myscholar-badge--tone-good { background:#042f2e !important; color:#2dd4bf !important; border-color:#0f766e !important; }
        .myscholar-badge--group-open.myscholar-badge--tone-info { background:#083344 !important; color:#22d3ee !important; border-color:#0e7490 !important; }
        .myscholar-badge--group-open.myscholar-badge--tone-neutral { background:#164e63 !important; color:#67e8f9 !important; border-color:#0e7490 !important; }
        .myscholar-badge--group-local.myscholar-badge--tone-top { background:#431407 !important; color:#fed7aa !important; border-color:#c2410c !important; }
        .myscholar-badge--group-local.myscholar-badge--tone-good { background:#451a03 !important; color:#fdba74 !important; border-color:#9a3412 !important; }
        .myscholar-badge--group-local.myscholar-badge--tone-info { background:#422006 !important; color:#fcd34d !important; border-color:#a16207 !important; }
        .myscholar-badge--group-local.myscholar-badge--tone-neutral { background:#451a03 !important; color:#fcd34d !important; border-color:#78350f !important; }
      }
      .myscholar-letpub { appearance:none !important; box-sizing:border-box !important; display:inline-flex !important; align-items:center !important; gap:0 !important; max-width:none !important; min-height:22px !important; margin:0 !important; padding:2px 9px !important; border:1px solid #94a3b8 !important; border-radius:999px !important; background:#ffffff !important; color:#475569 !important; font:600 12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif !important; text-decoration:none !important; vertical-align:middle !important; cursor:pointer !important; box-shadow:none !important; overflow:visible !important; white-space:nowrap !important; transition:background .15s,border-color .15s,color .15s !important; }
      .myscholar-letpub:hover { background:#0ea5e9 !important; border-color:#0284c7 !important; color:#ffffff !important; }
      @media (prefers-color-scheme:dark) { .myscholar-letpub { background:#1e293b !important; color:#cbd5e1 !important; border-color:#475569 !important; } .myscholar-letpub:hover { background:#0ea5e9 !important; border-color:#0284c7 !important; color:#ffffff !important; } }
      @media print { .myscholar-badges, #myscholar-ui-host { display:none !important; } }
      @media (prefers-reduced-motion:reduce) { .myscholar-badge--loading { animation:none !important; } }
    `;
    if (typeof GM_addStyle === 'function') GM_addStyle(css);
    else {
      const style = document.createElement('style');
      style.textContent = css;
      (document.head || document.documentElement).append(style);
    }
    state.globalStylesAdded = true;
  }

  function safeLink(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.toString() : '';
    } catch (_) {
      return '';
    }
  }

  function setText(element, value) {
    element.textContent = cleanText(value);
    return element;
  }

  function el(tag, className = '', textValue = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (textValue) setText(element, textValue);
    return element;
  }

  function initUi() {
    if (state.ui) return state.ui;
    const host = document.createElement('div');
    host.id = 'myscholar-ui-host';
    document.documentElement.append(host);
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all:initial; color-scheme:light dark; }
      * { box-sizing:border-box; }
      button,input,textarea { font:inherit; }
      .tooltip { position:fixed; z-index:2147483647; display:none; max-width:min(360px,calc(100vw - 24px)); padding:9px 11px; border:1px solid #334155; border-radius:9px; background:#0f172a; color:#f8fafc; font:12px/1.55 system-ui,"PingFang SC",sans-serif; box-shadow:0 10px 32px rgba(0,0,0,.3); pointer-events:none; white-space:pre-line; }
      .backdrop { position:fixed; inset:0; z-index:2147483646; display:none; align-items:center; justify-content:center; padding:18px; background:rgba(15,23,42,.5); font:14px/1.55 system-ui,"PingFang SC",sans-serif; color:#0f172a; }
      .backdrop.open { display:flex; }
      .panel { width:min(680px,100%); max-height:min(780px,calc(100vh - 36px)); overflow:auto; border:1px solid #cbd5e1; border-radius:16px; background:#fff; box-shadow:0 24px 70px rgba(0,0,0,.32); }
      .head { position:sticky; top:0; z-index:1; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:15px 18px; border-bottom:1px solid #e2e8f0; background:rgba(255,255,255,.96); backdrop-filter:blur(8px); }
      h2 { margin:0; font-size:17px; line-height:1.3; }
      h3 { margin:18px 0 8px; font-size:14px; }
      .close { border:0; border-radius:8px; padding:6px 9px; color:#475569; background:#f1f5f9; cursor:pointer; }
      .body { padding:16px 18px 20px; }
      .paper { margin:0 0 12px; font-size:15px; font-weight:700; }
      .meta { display:grid; grid-template-columns:max-content 1fr; gap:6px 12px; margin:0; font-size:12px; }
      .meta dt { color:#64748b; }
      .meta dd { margin:0; overflow-wrap:anywhere; }
      .meta a,.source a,.help a { color:#0f766e; }
      .metrics { display:grid; gap:8px; }
      .metric { padding:10px 11px; border:1px solid #e2e8f0; border-radius:10px; background:#f8fafc; }
      .metric-line { display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
      .metric strong { font-size:13px; }
      .metric-value { color:#0f766e; font-weight:750; text-align:right; }
      .source,.note { margin-top:4px; color:#64748b; font-size:11px; }
      .notice { margin:10px 0; padding:9px 11px; border-left:3px solid #f59e0b; background:#fffbeb; color:#92400e; font-size:12px; }
      .tabs { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
      .tab { border:1px solid #cbd5e1; border-radius:999px; padding:5px 11px; background:#fff; color:#334155; cursor:pointer; }
      .tab.active { border-color:#0f766e; background:#f0fdfa; color:#115e59; font-weight:700; }
      .section[hidden] { display:none; }
      .field { display:grid; gap:5px; margin:12px 0; }
      .field.inline { grid-template-columns:1fr auto; align-items:center; }
      label { font-weight:650; }
      .hint { color:#64748b; font-size:11px; }
      .label-tools { display:flex; flex-wrap:wrap; gap:7px; margin:10px 0 4px; }
      .label-group { margin-top:15px; }
      .label-group h3 { margin:0 0 7px; color:#475569; }
      .label-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:6px 12px; }
      .label-option { display:flex; align-items:flex-start; gap:7px; min-width:0; padding:5px 7px; border:1px solid #e2e8f0; border-radius:8px; background:#f8fafc; font-size:12px; font-weight:500; }
      .label-option input { flex:none; margin-top:2px; }
      .label-option span { min-width:0; overflow-wrap:anywhere; }
      input[type="text"],input[type="password"],input[type="email"],input[type="number"],textarea { width:100%; border:1px solid #cbd5e1; border-radius:8px; padding:8px 9px; background:#fff; color:#0f172a; }
      textarea { min-height:155px; resize:vertical; font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
      input:focus,textarea:focus { border-color:#0f766e; outline:3px solid rgba(20,184,166,.17); }
      .actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; margin-top:18px; }
      .action { border:1px solid #cbd5e1; border-radius:9px; padding:8px 12px; background:#fff; color:#334155; cursor:pointer; }
      .action.primary { border-color:#0f766e; background:#0f766e; color:#fff; }
      .status { min-height:20px; margin-top:9px; color:#0f766e; font-size:12px; }
      @media (prefers-color-scheme:dark) {
        .panel,.head { background:#0f172a; color:#e2e8f0; border-color:#334155; }
        .head { background:rgba(15,23,42,.96); }
        .close,.tab,.action,input[type="text"],input[type="password"],input[type="email"],input[type="number"],textarea { background:#1e293b; color:#e2e8f0; border-color:#475569; }
        .metric,.label-option { background:#1e293b; border-color:#334155; }
        .label-group h3 { color:#cbd5e1; }
        .notice { background:#451a03; color:#fde68a; }
      }
      @media (max-width:520px) { .backdrop { padding:8px; } .panel { max-height:calc(100vh - 16px); border-radius:12px; } .meta,.label-grid { grid-template-columns:1fr; } .meta dt { margin-top:4px; } }
      @media (prefers-reduced-motion:reduce) { * { scroll-behavior:auto !important; } }
    `;
    root.append(style);

    const tooltip = el('div', 'tooltip');
    tooltip.setAttribute('role', 'tooltip');
    root.append(tooltip);

    const backdrop = el('div', 'backdrop');
    backdrop.setAttribute('role', 'presentation');
    const panel = el('section', 'panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    const head = el('div', 'head');
    const heading = el('h2', '', 'MyScholar');
    const close = el('button', 'close', '关闭');
    close.type = 'button';
    head.append(heading, close);
    const body = el('div', 'body');
    panel.append(head, body);
    backdrop.append(panel);
    root.append(backdrop);

    const hidePanel = () => {
      backdrop.classList.remove('open');
      body.replaceChildren();
      const returnFocus = state.ui?.returnFocus;
      if (state.ui) state.ui.returnFocus = null;
      if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') {
        try { returnFocus.focus({ preventScroll: true }); } catch (_) { returnFocus.focus(); }
      }
    };
    close.addEventListener('click', hidePanel);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) hidePanel();
    });
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && backdrop.classList.contains('open')) hidePanel();
    });
    state.ui = { host, root, tooltip, backdrop, panel, heading, body, close, hidePanel, returnFocus: null };
    return state.ui;
  }

  function tooltipText(metric) {
    return [
      `${metric.label}：${metric.value}`,
      metric.source ? `来源：${metric.source}` : '',
      metric.year ? `版本/年份：${metric.year}` : '',
      metric.note,
    ].filter(Boolean).join('\n');
  }

  function showTooltip(badge) {
    const detail = state.detailById.get(badge.dataset.detailId);
    const metric = detail?.metrics?.find((item) => item.id === badge.dataset.metricId) || badge.__myscholarMetric;
    if (!metric || !state.ui) return;
    const tooltip = state.ui.tooltip;
    tooltip.textContent = tooltipText(metric);
    tooltip.style.display = 'block';
    const rect = badge.getBoundingClientRect();
    const tipRect = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, rect.left));
    const below = rect.bottom + 7;
    const top = below + tipRect.height < window.innerHeight
      ? below
      : Math.max(8, rect.top - tipRect.height - 7);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTooltip() {
    if (state.ui) state.ui.tooltip.style.display = 'none';
  }

  function appendMeta(dl, label, value, href = '') {
    if (!cleanText(value)) return;
    dl.append(setText(el('dt'), label));
    const dd = el('dd');
    const url = safeLink(href);
    if (url) {
      const anchor = setText(el('a'), value);
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      dd.append(anchor);
    } else setText(dd, value);
    dl.append(dd);
  }

  function openDetails(detailId) {
    const detail = state.detailById.get(detailId);
    if (!detail) return;
    const ui = initUi();
    ui.returnFocus = document.activeElement;
    ui.heading.textContent = '期刊信息详情';
    const body = ui.body;
    body.replaceChildren();
    body.append(setText(el('p', 'paper'), detail.paperTitle));
    const dl = el('dl', 'meta');
    appendMeta(dl, '匹配期刊', detail.journal || '未提供');
    appendMeta(dl, 'ISSN', detail.issns.join(' / '));
    appendMeta(dl, 'DOI', detail.doi, detail.doi ? `https://doi.org/${detail.doi}` : '');
    appendMeta(dl, '识别方式', `${detail.match.method}${Number.isFinite(detail.match.confidence) ? ` · 置信度 ${(detail.match.confidence * 100).toFixed(0)}%` : ''}`);
    appendMeta(dl, '匹配题名', detail.match.matchedTitle);
    appendMeta(dl, '页面来源', detail.site);
    body.append(dl);
    (detail.notices || []).forEach((notice) => body.append(setText(el('div', 'notice'), notice)));
    body.append(setText(el('h3'), `指标与收录（${detail.metrics.length}）`));
    const list = el('div', 'metrics');
    detail.metrics.forEach((metric) => {
      const card = el('article', 'metric');
      const line = el('div', 'metric-line');
      line.append(setText(el('strong'), metric.label), setText(el('span', 'metric-value'), metric.value));
      card.append(line);
      const source = el('div', 'source');
      source.append(document.createTextNode(`来源：${metric.source || '未注明'}${metric.year ? ` · ${metric.year}` : ''}`));
      const sourceUrl = safeLink(metric.url);
      if (sourceUrl) {
        source.append(document.createTextNode(' · '));
        const anchor = setText(el('a'), '核验来源');
        anchor.href = sourceUrl;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        source.append(anchor);
      }
      card.append(source);
      if (metric.note) card.append(setText(el('div', 'note'), metric.note));
      list.append(card);
    });
    body.append(list);
    ui.backdrop.classList.add('open');
    ui.close.focus();
  }

  function fieldBlock(labelText, input, hintText = '') {
    const block = el('div', 'field');
    const label = setText(el('label'), labelText);
    label.htmlFor = input.id;
    block.append(label, input);
    if (hintText) block.append(setText(el('div', 'hint'), hintText));
    return block;
  }

  function checkboxBlock(labelText, checked, name, hintText = '') {
    const block = el('div', 'field inline');
    const label = setText(el('label'), labelText);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = name;
    input.checked = Boolean(checked);
    label.htmlFor = `myscholar-${name}`;
    input.id = `myscholar-${name}`;
    block.append(label, input);
    if (hintText) {
      const hint = setText(el('div', 'hint'), hintText);
      hint.style.gridColumn = '1 / -1';
      block.append(hint);
    }
    return { block, input };
  }

  function openSettings() {
    const ui = initUi();
    ui.returnFocus = document.activeElement;
    ui.heading.textContent = `MyScholar 设置 · v${VERSION}`;
    const body = ui.body;
    body.replaceChildren();
    const form = document.createElement('form');
    form.addEventListener('submit', (event) => event.preventDefault());

    const tabs = el('div', 'tabs');
    const generalTab = el('button', 'tab active', '常规');
    const labelsTab = el('button', 'tab', '标签显示');
    const sitesTab = el('button', 'tab', '网站范围');
    const dataTab = el('button', 'tab', '数据源');
    const localTab = el('button', 'tab', '本地数据');
    [generalTab, labelsTab, sitesTab, dataTab, localTab].forEach((button) => { button.type = 'button'; });
    tabs.append(generalTab, labelsTab, sitesTab, dataTab, localTab);
    form.append(tabs);

    const general = el('div', 'section');
    const labels = el('div', 'section');
    const sites = el('div', 'section');
    const data = el('div', 'section');
    const local = el('div', 'section');
    labels.hidden = true;
    sites.hidden = true;
    data.hidden = true;
    local.hidden = true;

    const enabled = checkboxBlock('启用自动标注', state.config.enabled, 'enabled');
    const maxBadges = document.createElement('input');
    maxBadges.id = 'myscholar-max-badges';
    maxBadges.type = 'number';
    maxBadges.min = '1';
    maxBadges.max = '12';
    maxBadges.value = String(state.config.maxBadges);
    general.append(enabled.block, fieldBlock('每篇最多显示的标签数', maxBadges, '多出的已启用标签折叠为“+N”；点击任一标签可查看当前启用标签的完整来源。'));

    const labelOptions = allMetricOptions(state.labelCatalog);
    const hiddenMetricKeys = new Set(state.config.hiddenMetricKeys);
    const labelInputs = [];
    const labelRows = [];
    const labelGroupBlocks = [];
    labels.append(setText(el('div', 'hint'), '选择要显示在论文标题旁和详情面板中的标签。旧配置及新发现的标签默认显示；风险、撤稿提示也可在这里明确关闭。'));
    const labelSearch = document.createElement('input');
    labelSearch.id = 'myscholar-label-search';
    labelSearch.type = 'text';
    labelSearch.placeholder = '例如：JCR、DOAJ、CCF、本校等级';
    labels.append(fieldBlock('搜索标签', labelSearch));
    const labelTools = el('div', 'label-tools');
    const selectAll = el('button', 'action', '全部选中');
    const selectNone = el('button', 'action', '全部不选');
    const resetLabels = el('button', 'action', '恢复默认');
    [selectAll, selectNone, resetLabels].forEach((button) => { button.type = 'button'; });
    labelTools.append(selectAll, selectNone, resetLabels);
    const labelSummary = el('div', 'hint');
    labels.append(labelTools, labelSummary);
    const optionsByGroup = new Map();
    labelOptions.forEach((option) => {
      if (!optionsByGroup.has(option.group)) optionsByGroup.set(option.group, []);
      optionsByGroup.get(option.group).push(option);
    });
    optionsByGroup.forEach((options, group) => {
      const block = el('section', 'label-group');
      block.append(setText(el('h3'), group));
      const grid = el('div', 'label-grid');
      const rows = [];
      options.forEach((option, index) => {
        const row = el('label', 'label-option');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'metric-visibility';
        input.id = `myscholar-label-${labelInputs.length}`;
        input.checked = !hiddenMetricKeys.has(option.key);
        row.htmlFor = input.id;
        row.append(input, setText(el('span'), option.label));
        grid.append(row);
        const item = { key: option.key, input, option, row };
        labelInputs.push(item);
        labelRows.push(item);
        rows.push(item);
      });
      block.append(grid);
      labels.append(block);
      labelGroupBlocks.push({ block, rows });
    });
    const updateLabelSummary = () => {
      const enabledCount = labelInputs.filter((item) => item.input.checked).length;
      labelSummary.textContent = `已选择 ${enabledCount} / ${labelInputs.length} 项；未出现过的动态标签会在首次识别后加入此列表。`;
    };
    let clearUnknownHiddenOnSave = false;
    const applyDefaultLabelState = () => {
      labelInputs.forEach((item) => {
        item.input.checked = VISIBLE_BY_DEFAULT.has(item.key);
      });
      updateLabelSummary();
    };
    const setAllLabels = (checked, resetUnknown = false) => {
      labelInputs.forEach((item) => { item.input.checked = checked; });
      if (resetUnknown) clearUnknownHiddenOnSave = true;
      updateLabelSummary();
    };
    selectAll.addEventListener('click', () => setAllLabels(true, true));
    selectNone.addEventListener('click', () => setAllLabels(false));
    resetLabels.addEventListener('click', () => {
      clearUnknownHiddenOnSave = false;
      applyDefaultLabelState();
    });
    labelInputs.forEach((item) => item.input.addEventListener('change', updateLabelSummary));
    labelSearch.addEventListener('input', () => {
      const query = normalizeTitle(labelSearch.value);
      labelRows.forEach((item) => {
        item.row.style.display = !query || normalizeTitle(`${item.option.label} ${item.option.group}`).includes(query) ? '' : 'none';
      });
      labelGroupBlocks.forEach(({ block, rows }) => {
        block.style.display = rows.some((item) => item.row.style.display !== 'none') ? '' : 'none';
      });
    });
    updateLabelSummary();

    const knownSites = checkboxBlock(
      '启用内置学术网站适配',
      state.config.enableKnownSites,
      'known-sites',
      '继续使用 Google Scholar、PubMed、Web of Science、ScienceDirect 等已有专用适配器。',
    );
    const doiAnywhere = checkboxBlock(
      '在任意 HTTPS 论文详情页自动识别结构化 DOI',
      state.config.enableDoiAnywhere,
      'doi-anywhere',
      '默认关闭。开启后只接受 publication_doi、citation_doi、DC/PRISM 元数据、论文 JSON-LD 等与标题绑定的强信号；不扫描正文或参考文献中的裸 DOI。识别到论文后才会查询已启用的数据源。',
    );
    const customSites = document.createElement('textarea');
    customSites.id = 'myscholar-custom-sites';
    customSites.spellcheck = false;
    customSites.style.minHeight = '110px';
    customSites.value = state.config.customSiteRules.join('\n');
    const currentHost = effectiveHostname();
    const currentPlan = currentScanPlan();
    const modeLabels = {
      known: '内置适配器已启用',
      custom: '自定义网站已启用',
      automatic: '结构化 DOI 自动识别已启用',
      inactive: '当前不自动标注',
    };
    const siteStatus = setText(el('div', 'notice'), `当前网站：${currentHost || '未知'} · ${modeLabels[currentPlan.mode]}`);
    const siteTools = el('div', 'label-tools');
    const toggleCurrentSite = el('button', 'action');
    toggleCurrentSite.type = 'button';
    const updateCurrentSiteButton = () => {
      const exact = normalizeSiteRules(customSites.value).includes(currentHost);
      toggleCurrentSite.textContent = exact ? '移除当前网站' : '添加当前网站';
    };
    updateCurrentSiteButton();
    toggleCurrentSite.addEventListener('click', () => {
      const rules = new Set(normalizeSiteRules(customSites.value));
      if (rules.has(currentHost)) rules.delete(currentHost);
      else if (currentHost) rules.add(currentHost);
      customSites.value = [...rules].sort().join('\n');
      updateCurrentSiteButton();
    });
    customSites.addEventListener('input', updateCurrentSiteButton);
    siteTools.append(toggleCurrentSite);
    sites.append(
      siteStatus,
      knownSites.block,
      doiAnywhere.block,
      fieldBlock(
        '使用通用 DOI 识别的自定义网站',
        customSites,
        '一行一个精确域名，例如 pubsonline.informs.org、journals.sagepub.com。为避免误授权共享托管域名，不接受通配符；需要多个子域时请逐行添加。自定义网站可识别结构化详情页和带 DOI 的论文列表卡片，但不会扫描正文文本。',
      ),
      siteTools,
      setText(el('div', 'hint'), '为允许用户在任意出版社页面打开设置，本脚本声明 https://*/* 页面权限；未命中内置、自定义或已开启的结构化 DOI 规则时，不启动页面观察器，也不发送网络请求。'),
    );

    const easyKey = document.createElement('input');
    easyKey.id = 'myscholar-easy-key';
    easyKey.type = 'password';
    easyKey.autocomplete = 'off';
    easyKey.value = state.config.easyScholarKey;
    const easyKeyField = fieldBlock('EasyScholar Open API Secret Key（可选）', easyKey, '仅保存在本油猴脚本的 GM 本地存储；查询时按官方 GET 接口要求，仅发送给 www.easyscholar.cc。留空并保存即可清除。');
    const easyDebugTools = el('div', 'label-tools');
    const dumpEasyBtn = el('button', 'action', '输出最近一次 EasyScholar 响应');
    dumpEasyBtn.type = 'button';
    const dumpEasyStatus = el('div', 'hint');
    dumpEasyBtn.addEventListener('click', () => {
      const last = state.debugLastEasyScholar;
      if (!last) {
        dumpEasyStatus.textContent = '暂无记录；请先在页面中至少标注一篇已启用 EasyScholar 数据源的论文。';
        return;
      }
      const toPrint = { ...last };
      delete toPrint.rawPayload;
      const kConsole = console;
      kConsole.groupCollapsed(`[MyScholar] EasyScholar 调试 · ${last.journal || '未提供期刊名'} · ${new Date(last.requestedAt || Date.now()).toLocaleString()}`);
      kConsole.log('概览：', toPrint);
      if (last.rawPayload !== undefined) kConsole.log('原始 rawPayload：', last.rawPayload);
      kConsole.groupEnd();
      try {
        const debugUi = initUi();
        const prevHeading = debugUi.heading.textContent;
        debugUi.heading.textContent = 'EasyScholar 调试 · 最近一次响应';
        const debugBody = debugUi.body;
        debugBody.replaceChildren();
        const summary = el('dl', 'meta');
        appendMeta(summary, '查询期刊', last.journal || '');
        appendMeta(summary, '请求地址', last.url || '', /^https?:/.test(last.url || '') ? last.url : '');
        const fmt = (ts) => ts ? new Date(ts).toLocaleString() : '';
        appendMeta(summary, '请求时间', fmt(last.requestedAt));
        appendMeta(summary, '完成时间', fmt(last.fetchedAt));
        if (last.fromCache) appendMeta(summary, '缓存命中', '是 · 原始 rawPayload 未重新请求');
        if (last.skipped) appendMeta(summary, '跳过原因', last.skippedReason || '未启用');
        if (Number.isFinite(last.code)) appendMeta(summary, '响应 code', String(last.code));
        if (cleanText(last.msg)) appendMeta(summary, '响应 msg', last.msg);
        if (Number.isFinite(last.parsedCount)) appendMeta(summary, '解析出的标签数', String(last.parsedCount));
        if (Number.isFinite(last.cachedResultCount)) appendMeta(summary, '缓存内标签数', String(last.cachedResultCount));
        if (cleanText(last.error)) appendMeta(summary, '错误信息', last.error);
        debugBody.append(summary);
        debugBody.append(setText(el('h3'), '完整 JSON（可复制）'));
        const debugArea = document.createElement('textarea');
        debugArea.spellcheck = false;
        debugArea.readOnly = true;
        const serializable = { ...last };
        if (serializable.rawPayload !== undefined) {
          try { serializable.rawPayload = JSON.parse(JSON.stringify(last.rawPayload)); } catch (_) { }
        }
        debugArea.value = JSON.stringify(last, null, 2);
        debugArea.style.minHeight = '220px';
        debugBody.append(debugArea);
        const actions = el('div', 'actions');
        const copyBtn = el('button', 'action primary', '复制 JSON');
        copyBtn.type = 'button';
        const closeBtn = el('button', 'action', '返回设置');
        closeBtn.type = 'button';
        actions.append(copyBtn, closeBtn);
        debugBody.append(actions);
        const copyStatus = el('div', 'status');
        debugBody.append(copyStatus);
        copyBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(debugArea.value);
            copyStatus.textContent = '已复制到剪贴板。';
          } catch (_) {
            debugArea.select();
            document.execCommand('copy');
            copyStatus.textContent = '已尝试使用兼容性复制；请手动确认。';
          }
        });
        closeBtn.addEventListener('click', () => {
          debugUi.heading.textContent = prevHeading;
          openSettings();
        });
        dumpEasyStatus.textContent = '已在控制台（Console）输出结构化数据；详细 JSON 在弹窗中。';
      } catch (e) {
        dumpEasyStatus.textContent = `控制台已输出；弹窗失败：${cleanText(e.message)}`;
      }
    });
    easyDebugTools.append(dumpEasyBtn);
    data.append(
      easyKeyField,
      easyDebugTools,
      dumpEasyStatus,
    );

    const textarea = document.createElement('textarea');
    textarea.id = 'myscholar-local-data';
    textarea.spellcheck = false;
    textarea.value = state.localRaw;
    local.append(
      fieldBlock(
        '本地 JSON 或 CSV',
        textarea,
        '按 ISSN 优先、期刊名精确匹配。JSON 示例：[{"journal":"Nature","issn":"0028-0836","year":"2025","source":"我的授权数据","metrics":{"JCR":"Q1"}}]。数据仅保存在脚本管理器本地。',
      ),
      setText(el('div', 'notice'), '中科院文献情报中心已自 2026 年起停止更新与发布期刊分区表；请勿导入或传播无权使用的数据，历史值务必注明年份。'),
    );

    const sections = [general, labels, sites, data, local];
    const buttons = [generalTab, labelsTab, sitesTab, dataTab, localTab];
    buttons.forEach((button, index) => button.addEventListener('click', () => {
      buttons.forEach((item, itemIndex) => item.classList.toggle('active', itemIndex === index));
      sections.forEach((section, itemIndex) => { section.hidden = itemIndex !== index; });
    }));
    form.append(general, labels, sites, data, local);

    const status = el('div', 'status');
    const actions = el('div', 'actions');
      const clear = el('button', 'action', '清空缓存');
    const cancel = el('button', 'action', '取消');
    const save = el('button', 'action primary', '保存并重新扫描');
    [clear, cancel, save].forEach((button) => { button.type = 'button'; });
    actions.append(clear, cancel, save);
    form.append(actions, status);
    body.append(form);

    cancel.addEventListener('click', ui.hidePanel);
    clear.addEventListener('click', () => {
      state.cache = {};
      gmDelete(CACHE_KEY);
      status.textContent = '缓存已清空。';
    });
    save.addEventListener('click', () => {
      try {
        const nextLocalRaw = textarea.value.trim();
        const parsedLocal = parseLocalDataset(nextLocalRaw);
        const previousEasyKey = cleanText(state.config.easyScholarKey);
        const nextEasyKey = easyKey.value.trim();
        const nextEasyProfileId = nextEasyKey
          ? (previousEasyKey === nextEasyKey && /^[a-f0-9]{32}$/i.test(state.config.easyScholarProfileId)
            ? state.config.easyScholarProfileId
            : randomLocalId())
          : '';
        const nextHiddenMetricKeys = new Set(clearUnknownHiddenOnSave ? [] : state.config.hiddenMetricKeys);
        labelInputs.forEach(({ key, input }) => {
          if (input.checked) nextHiddenMetricKeys.delete(key);
          else nextHiddenMetricKeys.add(key);
        });
        state.config = {
          ...state.config,
          enabled: enabled.input.checked,
          enableKnownSites: knownSites.input.checked,
          enableDoiAnywhere: doiAnywhere.input.checked,
          customSiteRules: normalizeSiteRules(customSites.value),
          easyScholarKey: nextEasyKey,
          easyScholarProfileId: nextEasyProfileId,
          maxBadges: Math.min(12, Math.max(1, Number(maxBadges.value) || 6)),
          hiddenMetricKeys: normalizeHiddenMetricKeys([...nextHiddenMetricKeys]),
        };
        state.localRaw = nextLocalRaw;
        state.localIndex = indexLocalDataset(parsedLocal);
        rememberMetricOptions(parsedLocal.flatMap((record) => record.metrics));
        if (previousEasyKey !== nextEasyKey) {
          abortOutstandingEasyScholarRequests();
          clearEasyScholarCache();
        }
        gmSet(CONFIG_KEY, state.config);
        gmSet(LOCAL_DATA_KEY, state.localRaw);
        status.textContent = `已保存；本地数据 ${parsedLocal.length} 条。`;
        resetAndScan();
        setTimeout(ui.hidePanel, 450);
      } catch (error) {
        status.textContent = `本地数据格式错误：${cleanText(error.message)}`;
      }
    });

    ui.backdrop.classList.add('open');
    ui.close.focus();
  }

  function createContainer(descriptor) {
    const container = el('span', 'myscholar-badges');
    container.dataset.myscholarFor = hashString(normalizeTitle(descriptor.title));
    const loading = el('span', 'myscholar-badge myscholar-badge--loading', '期刊信息 · 查询中');
    loading.setAttribute('aria-live', 'polite');
    container.append(loading);
    descriptor.target.insertAdjacentElement('afterend', container);
    state.containerRecords.add({ container, target: descriptor.target, card: descriptor.card, detailId: '', descriptor });
    return container;
  }

  function makeBadge(metric, detailId) {
    const isRedundant = metric.label === metric.value;
    const classes = ['myscholar-badge', `myscholar-badge--group-${metric.group || 'metric'}`, `myscholar-badge--tone-${metric.tone || 'neutral'}`];
    if (isRedundant) classes.push('myscholar-badge--label-only');
    const button = el('button', classes.join(' '));
    button.type = 'button';
    button.dataset.detailId = detailId;
    button.dataset.metricId = metric.id;
    button.__myscholarMetric = metric;
    button.setAttribute('aria-label', isRedundant ? `${metric.label}；点击查看来源` : `${metric.label}：${metric.value}；点击查看来源`);
    button.title = tooltipText(metric);
    if (isRedundant) {
      button.append(setText(el('span', 'myscholar-badge__label'), metric.label));
    } else {
      button.append(setText(el('span', 'myscholar-badge__label'), metric.label), setText(el('span', 'myscholar-badge__value'), metric.value));
    }
    button.addEventListener('mouseenter', () => showTooltip(button));
    button.addEventListener('mouseleave', hideTooltip);
    button.addEventListener('focus', () => showTooltip(button));
    button.addEventListener('blur', hideTooltip);
    button.addEventListener('click', () => {
      hideTooltip();
      openDetails(detailId);
    });
    return button;
  }

  function letpubSearchUrl(journalName) {
    const encoded = encodeURIComponent(cleanText(journalName));
    return `https://www.letpub.com.cn/index.php?page=journalapp&view=search&searchname=${encoded}`;
  }

  function makeLetpubButton(journalName) {
    const url = letpubSearchUrl(journalName);
    const anchor = document.createElement('a');
    anchor.className = 'myscholar-letpub';
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = 'letpub';
    anchor.title = `在 LetPub 上检索 "${journalName}"`;
    return anchor;
  }

  function renderDetail(container, detail) {
    rememberMetricOptions(detail.metrics);
    const displayMetrics = filterVisibleMetrics(detail.metrics, state.config.hiddenMetricKeys);
    const record = [...state.containerRecords].find((item) => item.container === container);
    if (!displayMetrics.length) {
      if (record?.detailId) state.detailById.delete(record.detailId);
      if (record) record.detailId = '';
      container.replaceChildren();
      container.classList.add('myscholar-badges--empty');
      return false;
    }
    container.classList.remove('myscholar-badges--empty');
    const detailId = `d-${hashString(`${detail.doi}:${detail.paperTitle}:${Date.now()}:${Math.random()}`)}`;
    const displayDetail = { ...detail, metrics: displayMetrics };
    state.detailById.set(detailId, displayDetail);
    if (record) record.detailId = detailId;
    const shown = displayMetrics.slice(0, state.config.maxBadges);
    container.replaceChildren(...shown.map((metric) => makeBadge(metric, detailId)));
    if (displayMetrics.length > shown.length) {
      const moreMetric = makeMetric({
        id: 'more', label: '更多', value: `+${displayMetrics.length - shown.length}`,
        source: 'MyScholar', note: '点击查看其余已启用标签及每项数据来源。', group: 'journal', tone: 'neutral',
      });
      container.append(makeBadge(moreMetric, detailId));
    }
    if (detail.journal) {
      container.append(makeLetpubButton(detail.journal));
    }
    return true;
  }

  function localMetrics(journal, issns) {
    const matched = findLocalRecord(state.localIndex, journal, issns);
    if (!matched) return { metrics: [], notice: '' };
    return {
      metrics: matched.record.metrics.map((metric) => ({
        ...metric,
        note: `${metric.note} 匹配依据：${matched.method}。`,
      })),
      notice: `已使用本地数据（${matched.method}）；其正确性与授权由导入者负责。`,
    };
  }

  function descriptorRunIsCurrent(descriptor) {
    return Boolean(
      state.pageRuntimeActive
      && descriptor?.runtimeEpoch === state.runtimeEpoch
      && descriptor?.target?.isConnected
      && descriptor?.card?.isConnected
      && descriptor?.container?.isConnected
    );
  }

  function publicationStillMatchesDescriptor(descriptor) {
    if (!descriptor?.generic || descriptor.doiEvidence !== 'metadata') return true;
    const publication = currentStructuredPublication();
    return Boolean(
      publication
      && publication.doi === descriptor.doi
      && titleSimilarity(publication.title, descriptor.title) >= 0.78
    );
  }

  async function resolveDescriptor(descriptor, onPartial) {
    if (!descriptorRunIsCurrent(descriptor)) return null;
    if (!publicationStillMatchesDescriptor(descriptor)) return null;
    
    const journal = cleanText(descriptor.journalHint);
    if (!journal) return null;
    
    const issns = [];
    const doi = normalizeDoi(descriptor.doi) || '';
    const match = {
      method: '页面期刊字段', confidence: null, queryTitle: descriptor.title, matchedTitle: descriptor.title,
      yearDistance: 0,
    };
    
    // 累积式增量渲染：本地数据立即显示，EasyScholar 有结果就补充
    const accumulatedMetrics = [];
    const emitPartial = (newMetrics) => {
      if (!onPartial) return;
      for (const metric of newMetrics) {
        if (!accumulatedMetrics.some((m) => m.id === metric.id)) {
          accumulatedMetrics.push(metric);
        }
      }
      const deduped = metricDedupe(accumulatedMetrics);
      rememberMetricOptions(deduped);
      
      const journalMetric = makeMetric({
        id: 'journal:name', label: '期刊', value: journal, source: `${descriptor.site} 页面字段`,
        year: descriptor.year, note: '期刊名取自当前页面元数据；标签结果由本地目录和 EasyScholar 查询提供。',
        url: doi ? `https://doi.org/${doi}` : '', group: 'journal', tone: 'neutral',
      });
      
      const allMetrics = metricDedupe([...deduped, journalMetric]);
      
      onPartial({
        paperTitle: descriptor.title,
        site: descriptor.site,
        journal,
        issns,
        doi,
        match,
        metrics: allMetrics,
        notices: [],
      });
    };
    
    // 立即渲染本地数据（即使没有本地数据也要渲染期刊名称标签）
    const local = localMetrics(journal, issns);
    emitPartial(local.metrics);
    
    // EasyScholar 查询
    const easyMetrics = await settleWithin(lookupEasyScholar(journal, descriptor.runtimeGuard), 4000, []);
    if (!descriptorRunIsCurrent(descriptor)) return null;
    
    if (easyMetrics.length) {
      emitPartial(easyMetrics);
    }
    
    const notices = [];
    if (local.notice) notices.push(local.notice);
    if (easyMetrics.some((metric) => metric.group === 'cas')) {
      notices.push('中科院分区已自 2026 年起停止官方更新；这里的相关标签只能是历史口径。');
    }
    return {
      paperTitle: descriptor.title,
      site: descriptor.site,
      journal,
      issns,
      doi,
      match,
      metrics: metricDedupe(accumulatedMetrics),
      notices,
    };
  }

  function markSignatureCooldown(signature, retryAt) {
    if (!signature) return;
    state.signatureCooldowns.set(signature, retryAt);
    // 定期清理过期条目，避免长列表页面的内存占用
    if (state.signatureCooldowns.size > 120) {
      const now = Date.now();
      for (const [k, v] of state.signatureCooldowns) {
        if (v <= now) state.signatureCooldowns.delete(k);
      }
    }
  }
  function signatureIsCooling(signature) {
    if (!signature) return false;
    const retryAt = state.signatureCooldowns.get(signature);
    return retryAt !== undefined && retryAt > Date.now();
  }

  async function annotate(descriptor, container) {
    let partialRendered = false;
    try {
      const onPartial = (partialDetail) => {
        if (!container.isConnected) return;
        if (partialDetail && partialDetail.metrics.length) {
          const visibleCount = filterVisibleMetrics(partialDetail.metrics, state.config.hiddenMetricKeys).length;
          if (!visibleCount) return;
          const rendered = renderDetail(container, partialDetail);
          if (rendered) {
            partialRendered = true;
            const processed = state.processed.get(descriptor.target);
            if (processed?.container === container) processed.done = 'success';
          }
        }
      };
      const detailPromise = annotationQueue.add(() => resolveDescriptor(descriptor, onPartial));
      const detail = await rejectAfter(detailPromise, 45000);
      if (!container.isConnected) return;
      // 目标被页面替换（断连）时放弃本次渲染；仅暂时不可见则保留，恢复可见后徽章仍在
      if (!descriptor.target.isConnected || !descriptor.card?.isConnected || hashString(normalizeTitle(descriptor.target?.textContent)) !== descriptor.nodeSignature) {
        const processed = state.processed.get(descriptor.target);
        const retryAt = Date.now() + 5000;
        if (processed?.container === container) { processed.done = 'cooldown'; processed.retryAt = retryAt; }
        markSignatureCooldown(descriptor.identitySignature, retryAt);
        container.remove();
        return;
      }
      if (!detail || !detail.metrics.length) {
        if (partialRendered) return;
        const processed = state.processed.get(descriptor.target);
        const retryAt = Date.now() + 30000;
        if (processed?.container === container) { processed.done = 'cooldown'; processed.retryAt = retryAt; }
        markSignatureCooldown(descriptor.identitySignature, retryAt);
        if (state.config.showMisses) {
          container.replaceChildren(el('span', 'myscholar-badge myscholar-badge--loading', '未可靠匹配期刊'));
        } else container.remove();
        return;
      }
      renderDetail(container, detail);
      const processed = state.processed.get(descriptor.target);
      if (processed?.container === container) processed.done = 'success';
    } catch (error) {
      if (partialRendered) return;
      if (!container.isConnected) return;
      if (state.config.showMisses) {
        const failed = el('span', 'myscholar-badge myscholar-badge--group-danger myscholar-badge--tone-danger', '期刊信息 · 查询失败');
        failed.title = cleanText(error.message);
        container.replaceChildren(failed);
      } else container.remove();
      const processed = state.processed.get(descriptor.target);
      if (processed?.container === container) {
        const useCooldown = processed.attempts >= 2;
        processed.done = useCooldown ? 'cooldown' : 'error';
        processed.retryAt = Date.now() + (useCooldown ? 60000 : 30000);
        markSignatureCooldown(descriptor.identitySignature, processed.retryAt);
        if (processed.done === 'error') setTimeout(scheduleScan, 30100);
      }
    }
  }

  function queueDescriptor(descriptor) {
    if (!validDescriptor(descriptor)) return;
    descriptor.runtimeEpoch = state.runtimeEpoch;
    descriptor.runtimeGuard = () => descriptorRunIsCurrent(descriptor);
    const signature = descriptor.identitySignature;
    // 基于签名的冷却：跨 SPA DOM 替换仍生效，不依赖 WeakMap 的 target 引用
    if (signatureIsCooling(signature)) return;
    const previous = state.processed.get(descriptor.target);
    if (previous?.signature === signature && (
      previous.container?.isConnected
      || (previous.done === 'cooldown' && previous.retryAt > Date.now())
      || (previous.done === 'error' && previous.retryAt > Date.now())
    )) return;
    if (previous) {
      if (previous.container) state.visibleObserver?.unobserve(previous.container);
      previous.container?.remove();
    }
    const container = createContainer(descriptor);
    descriptor.container = container;
    state.processed.set(descriptor.target, {
      signature,
      container,
      done: 'pending',
      attempts: previous?.signature === signature ? (previous.attempts || 1) + 1 : 1,
    });
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      if (container.__myscholarFallbackTimer) {
        clearTimeout(container.__myscholarFallbackTimer);
        delete container.__myscholarFallbackTimer;
      }
      delete container.__myscholarStart;
      annotate(descriptor, container);
    };
    if (state.visibleObserver) {
      container.__myscholarStart = start;
      state.visibleObserver.observe(container);
      container.__myscholarFallbackTimer = setTimeout(() => {
        if (!container.isConnected) return;
        state.visibleObserver?.unobserve(container);
        start();
      }, 1000);
    } else start();
  }

  function scanPage() {
    if (!state.pageRuntimeActive || !state.config.enabled) return;
    const plan = currentScanPlan();
    if (plan.mode === 'inactive') {
      stopAnnotationRuntime();
      return;
    }
    cleanupContainers();
    let descriptors = [];
    if (plan.knownAdapter && state.config.enableKnownSites !== false) {
      try { descriptors = plan.knownAdapter.scan(); } catch (_) { descriptors = []; }
    }
    if (!descriptors.length || plan.isCustom) {
      try {
        descriptors.push(...genericDoiDescriptors({ includeCardLinks: plan.isCustom }));
      } catch (_) {
        // A publisher-specific adapter can still annotate if generic fallback fails.
      }
    }
    const currentDescriptors = dedupeDescriptors(descriptors).filter(validDescriptor);
    const currentTargets = new Set(currentDescriptors.map((descriptor) => descriptor.target));
    for (const record of [...state.containerRecords]) {
      if (currentTargets.has(record.target)) continue;
      // 目标只是暂时不可见（如祖先 aria-hidden）时不移除：恢复可见后徽章仍在
      const structurallyPresent = record.container.isConnected
        && record.target.isConnected
        && record.card?.contains?.(record.target)
        && record.card.contains(record.container);
      if (structurallyPresent) continue;
      state.visibleObserver?.unobserve(record.container);
      record.container.remove();
      if (record.detailId) state.detailById.delete(record.detailId);
      const processed = state.processed.get(record.target);
      if (processed?.container === record.container) {
        const retryAt = Date.now() + 5000;
        processed.done = 'cooldown';
        processed.retryAt = retryAt;
        if (processed.signature) markSignatureCooldown(processed.signature, retryAt);
      }
      state.containerRecords.delete(record);
    }
    currentDescriptors.forEach(queueDescriptor);
  }

  function findReplacementTarget(record) {
    const target = record.target;
    if (!target?.tagName) return null;
    const expected = record.container?.dataset?.myscholarFor
      || hashString(normalizeTitle(target.textContent));
    const candidates = document.querySelectorAll(target.tagName);
    for (const strictClass of [true, false]) {
      for (const node of candidates) {
        if (!node.isConnected || node === target) continue;
        if (strictClass && String(node.className) !== String(target.className)) continue;
        if (!isDescriptorTargetVisible(node)) continue;
        if (node.closest('.myscholar-badges, #myscholar-ui-host')) continue;
        if (hashString(normalizeTitle(node.textContent)) === expected) return node;
      }
    }
    return null;
  }

  function cleanupContainers() {
    for (const record of [...state.containerRecords]) {
      // SPA 重渲染可能整体替换 DOM 子树（如 ScienceDirect 文章头部）：此时徽章容器
      // 和目标节点一起被页面丢弃。优先把已渲染的徽章挂到新节点上，避免消失后等
      // 下一次扫描才补标；新节点尚未出现时按 miss 处理，让插入触发的扫描立即补标注。
      const targetReplaced = !record.target.isConnected;
      if (targetReplaced) {
        const replacement = findReplacementTarget(record);
        if (replacement) {
          replacement.insertAdjacentElement('afterend', record.container);
          const processed = state.processed.get(record.target);
          if (processed?.container === record.container) {
            state.processed.delete(record.target);
            state.processed.set(replacement, processed);
          }
          const newCard = replacement.closest('article, main') || replacement.parentElement;
          record.target = replacement;
          record.card = newCard;
          // 同步更新在途 descriptor 的引用，让进行中的查询继续渲染到迁移后的容器
          if (record.descriptor) {
            record.descriptor.target = replacement;
            record.descriptor.card = newCard;
          }
          continue;
        }
      }
      // 仅因祖先 [hidden]/aria-hidden 而暂时不可见时不移除：内容恢复可见时徽章仍在
      const valid = record.container.isConnected
        && record.card?.isConnected
        && record.card.contains(record.target)
        && record.card.contains(record.container);
      if (valid) continue;
      state.visibleObserver?.unobserve(record.container);
      if (record.container.__myscholarFallbackTimer) {
        clearTimeout(record.container.__myscholarFallbackTimer);
        delete record.container.__myscholarFallbackTimer;
      }
      record.container.remove();
      if (record.detailId) state.detailById.delete(record.detailId);
      const processed = state.processed.get(record.target);
      if (processed?.container === record.container) {
        if (targetReplaced) {
          processed.done = 'miss';
        } else {
          const retryAt = Date.now() + 5000;
          processed.done = 'cooldown';
          processed.retryAt = retryAt;
          if (processed.signature) markSignatureCooldown(processed.signature, retryAt);
        }
      }
      state.containerRecords.delete(record);
    }
  }

  function scheduleScan() {
    if (!state.pageRuntimeActive) return;
    if (state.scanTimer) clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      state.scanTimer = null;
      scanPage();
    }, 280);
  }

  function clearPageAnnotations() {
    state.containerRecords.forEach((record) => {
      state.visibleObserver?.unobserve(record.container);
      if (record.container.__myscholarFallbackTimer) {
        clearTimeout(record.container.__myscholarFallbackTimer);
        delete record.container.__myscholarFallbackTimer;
      }
    });
    document.querySelectorAll('.myscholar-badges').forEach((node) => node.remove());
    state.containerRecords.clear();
    state.processed = new WeakMap();
    state.signatureCooldowns.clear();
    state.detailById.clear();
  }

  function stopAnnotationRuntime() {
    if (state.scanTimer) clearTimeout(state.scanTimer);
    state.scanTimer = null;
    state.mutationObserver?.disconnect();
    state.visibleObserver?.disconnect();
    state.mutationObserver = null;
    state.visibleObserver = null;
    if (state.pageRuntimeActive) state.runtimeEpoch += 1;
    state.pageRuntimeActive = false;
    clearPageAnnotations();
  }

  function ensureAnnotationRuntime() {
    if (state.pageRuntimeActive) return;
    state.pageRuntimeActive = true;
    addGlobalStyles();
    initUi();
    observePage();
  }

  function reconcilePageActivation() {
    const plan = currentScanPlan();
    if (plan.mode === 'inactive') {
      stopAnnotationRuntime();
      return;
    }
    const wasActive = state.pageRuntimeActive;
    ensureAnnotationRuntime();
    if (wasActive) scheduleScan();
    else scanPage();
  }

  function resetAndScan() {
    state.runtimeEpoch += 1;
    clearPageAnnotations();
    reconcilePageActivation();
  }

  function observePage() {
    if (state.mutationObserver) return;
    if ('IntersectionObserver' in window) {
      state.visibleObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const container = entry.target;
          state.visibleObserver.unobserve(container);
          const start = container.__myscholarStart;
          delete container.__myscholarStart;
          if (typeof start === 'function') start();
        });
      }, { rootMargin: '700px 0px' });
    }
    state.mutationObserver = new MutationObserver((mutations) => {
      const shouldScan = mutations.some((mutation) => {
        if (mutation.type === 'characterData') {
          return !mutation.target.parentElement?.closest('#myscholar-ui-host, .myscholar-badges');
        }
        if (mutation.type === 'attributes') {
          return !mutation.target.closest?.('#myscholar-ui-host, .myscholar-badges');
        }
        const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
        return changedNodes.some((node) => {
          if (node.nodeType === Node.TEXT_NODE) return !node.parentElement?.closest('#myscholar-ui-host, .myscholar-badges');
          return node.nodeType === Node.ELEMENT_NODE && !node.closest?.('#myscholar-ui-host, .myscholar-badges');
        });
      });
      if (shouldScan) scheduleScan();
    });
    state.mutationObserver.observe(document.documentElement, {
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'href', 'content', 'name', 'property', 'value', 'data-doi',
        'data-paper-id', 'data-article-id', 'data-cid', 'hidden', 'aria-hidden',
      ],
      subtree: true,
    });
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    GM_registerMenuCommand('MyScholar：设置', openSettings);
    GM_registerMenuCommand('MyScholar：重新扫描本页', resetAndScan);
    GM_registerMenuCommand('MyScholar：清空缓存', () => {
      state.cache = {};
      gmDelete(CACHE_KEY);
      resetAndScan();
    });
  }

  function registerStorageListeners() {
    if (typeof GM_addValueChangeListener !== 'function') return;
    GM_addValueChangeListener(CONFIG_KEY, (_name, _oldValue, newValue, remote) => {
      if (!remote) return;
      const previousEasyKey = cleanText(state.config.easyScholarKey);
      const previousProfileId = cleanText(state.config.easyScholarProfileId);
      state.config = normalizeConfig(newValue);
      if (state.config.easyScholarKey && cleanText(newValue?.easyScholarProfileId) !== state.config.easyScholarProfileId) {
        gmSet(CONFIG_KEY, state.config);
      }
      if (previousEasyKey !== state.config.easyScholarKey || previousProfileId !== state.config.easyScholarProfileId) {
        abortOutstandingEasyScholarRequests();
        clearEasyScholarCache();
      }
      if (state.ui?.backdrop.classList.contains('open')) state.ui.hidePanel();
      resetAndScan();
    });
    GM_addValueChangeListener(LABEL_CATALOG_KEY, (_name, _oldValue, newValue, remote) => {
      if (!remote) return;
      const merged = mergeLabelCatalogs(state.labelCatalog, newValue);
      const localKeys = Object.keys(state.labelCatalog);
      const incomingKeys = new Set(Object.keys(normalizeLabelCatalog(newValue)));
      state.labelCatalog = merged;
      if (localKeys.some((key) => !incomingKeys.has(key))) scheduleLabelCatalogSave();
    });
  }

  function init() {
    loadState();
    registerMenus();
    registerStorageListeners();
    reconcilePageActivation();
    setInterval(() => {
      if (location.href !== state.lastUrl) {
        state.lastUrl = location.href;
        resetAndScan();
      } else if (!state.pageRuntimeActive && state.config.enabled && state.config.enableDoiAnywhere) {
        reconcilePageActivation();
      }
    }, 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
