(function(){"use strict";const p={max_steps:1e4,timeout_s:30,inactivity_s:10,max_output:65536,max_container:100,max_depth:3,max_repr:120};var y=`"""
Pyodide 运行时引导：把 JS 侧调用转换为 Python 入口。

由 Worker 在写入内存文件系统后执行一次，暴露：

- run(code, limits_json, emit_batch, is_cancelled)  执行并批量回传事件
- scaffold(code) -> str                              骨架与挖空解析（JSON 字符串）
- analyze(code) -> str                               依赖检测（JSON 字符串）
"""

import json
import sys

ROOT = '/wpt'
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from imports import analyze as _analyze  # noqa: E402
from limits import Limits  # noqa: E402
from scaffold.skeleton import extract as _extract  # noqa: E402
from tracer import run_code  # noqa: E402


def run(code, limits_json, emit_batch, is_cancelled=None):
    run_code(code, Limits(**json.loads(limits_json)), emit_batch, is_cancelled)


def scaffold(code):
    return json.dumps(_extract(code), ensure_ascii=False)


def analyze(code):
    return json.dumps(_analyze(code), ensure_ascii=False)
`,x=`"""
依赖检测：扫描 import / from ... import 的顶层模块名并分类。

- 标准库由 sys.stdlib_module_names 判定（Pyodide 内置 Python 版本为准）
- 随站点分发的第三方库：numpy / pandas / matplotlib
- 语法错误时返回空结果，交由骨架解析报告错误
"""

import ast
import sys

BUNDLED = {'numpy', 'pandas', 'matplotlib'}


def _top_names(tree) -> list[str]:
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom):
            # 相对导入没有顶层模块名可判定，直接跳过
            if node.level == 0 and node.module:
                names.add(node.module.split('.')[0])
    return sorted(names)


def analyze(code: str) -> dict:
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return {'supported': [], 'unsupported': []}

    supported: list[str] = []
    unsupported: list[str] = []
    for name in _top_names(tree):
        if name in sys.stdlib_module_names or name in BUNDLED:
            supported.append(name)
        else:
            unsupported.append(name)
    return {'supported': supported, 'unsupported': unsupported}
`,b=`"""执行防护限制：步数、超时、输出截断。"""\r
\r
from dataclasses import dataclass, asdict\r
\r
\r
@dataclass\r
class Limits:\r
    max_steps: int = 10000        # trace 事件步数上限\r
    timeout_s: float = 30.0       # 总执行超时（父进程强制 kill）\r
    inactivity_s: float = 10.0    # 单次读取事件流的超时\r
    max_output: int = 65536       # stdout 累计输出上限（字节）\r
    max_container: int = 100      # 容器可视化元素上限\r
    max_depth: int = 3            # 嵌套序列化深度上限\r
    max_repr: int = 120           # repr 字符串截断长度\r
\r
    def to_dict(self) -> dict:\r
        return asdict(self)\r
\r
\r
DEFAULT_LIMITS = Limits()\r
`,v=`"""Pyodide 内 scaffold 包。"""\r
`,g=`"""\r
占位符解析：扫描 ??? / {{choice:A,B,C}} 挖空，产出元数据与语法代理文本。\r
\r
- ???            → 自由填空（可带类型提示 ??? / ???:int）\r
- {{choice:A,B,C}} → 选择填空\r
\r
代理替换：占位符替换为合法标识符 __hole_<id>__，使残缺代码可被 ast.parse。\r
"""\r
\r
import re\r
\r
BLANK_RE = re.compile(r'\\?{3}(?::([a-zA-Z_]\\w*))?')\r
CHOICE_RE = re.compile(r'\\{\\{\\s*choice\\s*:\\s*([^{}]+?)\\s*\\}\\}')\r
\r
\r
class Hole:\r
    def __init__(self, hole_id: str, lineno: int, col_start: int, col_end: int,\r
                 kind: str, hint: str | None = None, choices: list[str] | None = None):\r
        self.id = hole_id\r
        self.lineno = lineno          # 1-based\r
        self.col_start = col_start    # 0-based\r
        self.col_end = col_end        # 绝对终点（exclusive），调用方传 m.end()\r
        self.kind = kind              # 'blank' | 'choice'\r
        self.hint = hint\r
        self.choices = choices or []\r
\r
    def to_dict(self) -> dict:\r
        return {\r
            'id': self.id,\r
            'lineno': self.lineno,\r
            'colStart': self.col_start,\r
            'colEnd': self.col_end,\r
            'kind': self.kind,\r
            'hint': self.hint,\r
            'choices': self.choices,\r
        }\r
\r
\r
def scan_holes(code: str) -> list[Hole]:\r
    """扫描全部占位符，按文本顺序编号 h1, h2, ..."""\r
    holes: list[Hole] = []\r
    counter = 0\r
    lines = code.splitlines()\r
\r
    # 逐行扫描避免跨行正则误配，并保持行号\r
    for lineno, line in enumerate(lines, start=1):\r
        # 整行注释（含中文注释里的挖空提示）：不在注释中挖空\r
        if line.lstrip().startswith('#'):\r
            continue\r
        # 先用占位字符保护 choice 区域，避免其中的内容被 blank 误匹配\r
        spans: list[tuple[int, int, Hole]] = []\r
\r
        for m in CHOICE_RE.finditer(line):\r
            raw = m.group(1)\r
            choices = [c.strip() for c in raw.split(',') if c.strip()]\r
            counter += 1\r
            holes.append(Hole(f'h{counter}', lineno, m.start(), m.end(), 'choice', choices=choices))\r
            spans.append((m.start(), m.end(), holes[-1]))\r
\r
        def in_choice(pos: int) -> bool:\r
            return any(s <= pos < e for s, e, _ in spans)\r
\r
        for m in BLANK_RE.finditer(line):\r
            if in_choice(m.start()):\r
                continue\r
            counter += 1\r
            holes.append(Hole(f'h{counter}', lineno, m.start(), m.end(), 'blank', hint=m.group(1)))\r
            spans.append((m.start(), m.end(), holes[-1]))\r
\r
    holes.sort(key=lambda h: (h.lineno, h.col_start))\r
    return holes\r
\r
\r
def proxy_text(code: str, holes: list[Hole]) -> str:\r
    """将占位符替换为 __hole_<id>__ 标识符，返回可解析文本。"""\r
    if not holes:\r
        return code\r
    lines = code.splitlines()\r
    # 按行倒序替换，避免列偏移\r
    by_line: dict[int, list[Hole]] = {}\r
    for h in holes:\r
        by_line.setdefault(h.lineno, []).append(h)\r
\r
    for lineno, hs in by_line.items():\r
        line = lines[lineno - 1]\r
        for h in sorted(hs, key=lambda x: -x.col_start):\r
            lines[lineno - 1] = line[: h.col_start] + f'__{h.id}__' + line[h.col_end:]\r
            line = lines[lineno - 1]\r
    return '\\n'.join(lines)\r
\r
\r
def try_repair_and_parse(proxied: str):\r
    """尝试解析；对'缺少缩进块'做启发式修复（在期望缩进列补 pass）。"""\r
    import ast\r
\r
    try:\r
        return ast.parse(proxied), None\r
    except SyntaxError as e:\r
        # IndentationError: expected an indented block —— e.offset 为期望缩进列\r
        if 'expected an indented block' in (e.msg or ''):\r
            indent = ' ' * max((e.offset or 1) - 1, 0)\r
            repaired = proxied + '\\n' + indent + 'pass'\r
            try:\r
                return ast.parse(repaired), None\r
            except SyntaxError as e2:\r
                return None, f'{e2.msg} (line {e2.lineno})'\r
        return None, f'{e.msg} (line {e.lineno})'\r
`,w=`"""\r
AST 骨架提取：把（含代理挖空的）AST 转为前端可渲染的骨架树 JSON。\r
\r
节点结构:\r
  { id, kind, lineno, title, children: [...], holeId?: 'hN' }\r
\r
kind ∈ module|funcdef|if|else|for|while|assign|aug|call|return|hole|expr|statement\r
"""\r
\r
import ast\r
\r
from scaffold.placeholder import Hole, scan_holes, proxy_text, try_repair_and_parse\r
\r
_MAX_TITLE = 70\r
\r
\r
def _cut(s: str, limit: int = _MAX_TITLE) -> str:\r
    s = s.strip()\r
    return s if len(s) <= limit else s[: limit - 3] + '...'\r
\r
\r
class SkeletonBuilder:\r
    def __init__(self, code: str, holes: list[Hole]):\r
        self.lines = code.splitlines()\r
        self.holes = holes\r
        self.counter = 0\r
\r
    def next_id(self) -> str:\r
        self.counter += 1\r
        return f'n{self.counter}'\r
\r
    def line_text(self, lineno: int) -> str:\r
        if 1 <= lineno <= len(self.lines):\r
            return self.lines[lineno - 1]\r
        return ''\r
\r
    def holes_in_range(self, node) -> list[Hole]:\r
        end = getattr(node, 'end_lineno', None) or node.lineno\r
        return [\r
            h for h in self.holes\r
            if node.lineno <= h.lineno <= end\r
        ]\r
\r
    def hole_names_in(self, node) -> set[str]:\r
        names = set()\r
        for sub in ast.walk(node):\r
            if isinstance(sub, ast.Name) and sub.id.startswith('__h') and sub.id.endswith('__'):\r
                names.add(sub.id[2:-2])\r
        return names\r
\r
    def build(self, node, label: str | None = None) -> dict:\r
        self.counter += 1\r
        nid = f'n{self.counter}'\r
\r
        is_structural = isinstance(node, (ast.FunctionDef, ast.If, ast.For, ast.While))\r
\r
        # 挖空代理节点（仅叶子语句；结构节点保持展开，让 hole 出现在子级）\r
        hole_ids = self.hole_names_in(node)\r
        if hole_ids and not is_structural:\r
            hid = sorted(hole_ids)[0]\r
            return {\r
                'id': nid, 'kind': 'hole', 'lineno': node.lineno,\r
                'title': self.line_text(node.lineno).strip() or '???',\r
                'children': [], 'holeId': hid,\r
            }\r
\r
        kind = type(node).__name__.lower()\r
        title = label or _cut(self.line_text(node.lineno)) or kind\r
        children: list[dict] = []\r
\r
        if isinstance(node, ast.FunctionDef):\r
            kind = 'funcdef'\r
            title = f'def {node.name}(...)'\r
            children = [self.build(s) for s in node.body]\r
        elif isinstance(node, ast.If):\r
            kind = 'if'\r
            title = _cut(self.line_text(node.lineno))\r
            children = [self.build(s) for s in node.body]\r
            if node.orelse:\r
                children.append(self._else_block(node.orelse))\r
        elif isinstance(node, ast.For):\r
            kind = 'for'\r
            title = _cut(self.line_text(node.lineno))\r
            children = [self.build(s) for s in node.body]\r
            if node.orelse:\r
                children.append(self._else_block(node.orelse))\r
        elif isinstance(node, ast.While):\r
            kind = 'while'\r
            title = f'while {_cut(self._seg(node.test))}:'\r
            children = [self.build(s) for s in node.body]\r
        elif isinstance(node, ast.Return):\r
            kind = 'return'\r
            title = 'return ' + (_cut(self._seg(node.value)) if node.value else '')\r
        elif isinstance(node, ast.Assign):\r
            kind = 'assign'\r
            targets = ', '.join(self._seg(t) for t in node.targets)\r
            title = f'{_cut(targets, 30)} = {_cut(self._seg(node.value), 40)}'\r
        elif isinstance(node, ast.AugAssign):\r
            kind = 'aug'\r
            title = _cut(self.line_text(node.lineno))\r
        elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):\r
            kind = 'call'\r
            title = _cut(self._seg(node.value))\r
        else:\r
            # 其余语句：整体一行标题，保留行级信息\r
            kind = 'statement'\r
\r
        return {'id': nid, 'kind': kind, 'lineno': node.lineno, 'title': title, 'children': children}\r
\r
    def _else_block(self, orelse) -> dict:\r
        self.counter += 1\r
        nid = f'n{self.counter}'\r
        if len(orelse) == 1 and isinstance(orelse[0], ast.If):\r
            node = self.build(orelse[0])\r
            return {'id': nid, 'kind': 'elif', 'lineno': orelse[0].lineno,\r
                    'title': node['title'], 'children': node['children']}\r
        return {\r
            'id': nid, 'kind': 'else', 'lineno': orelse[0].lineno, 'title': 'else:',\r
            'children': [self.build(s) for s in orelse],\r
        }\r
\r
    def _seg(self, node) -> str:\r
        try:\r
            return ast.get_source_segment('\\n'.join(self.proxied_lines), node) or ''\r
        except Exception:\r
            return ''\r
\r
\r
def extract(code: str) -> dict:\r
    """主入口：代码 → {ok, nodes, holes, error}。"""\r
    from scaffold.placeholder import Hole  # noqa: F401 (类型提示用)\r
\r
    holes = scan_holes(code)\r
    proxied = proxy_text(code, holes)\r
    tree, err = try_repair_and_parse(proxied)\r
\r
    if tree is None:\r
        return {'ok': False, 'nodes': [], 'holes': [h.to_dict() for h in holes], 'error': err or '语法解析失败'}\r
\r
    builder = SkeletonBuilder(code, holes)\r
    builder.proxied_lines = proxied.splitlines()\r
    nodes = [builder.build(stmt) for stmt in tree.body]\r
\r
    hole_dicts = []\r
    for h in holes:\r
        d = h.to_dict()\r
        hole_dicts.append(d)\r
\r
    return {'ok': True, 'nodes': nodes, 'holes': hole_dicts, 'error': None}\r
`,k=`"""\r
值序列化：把 Python 对象转换为可 JSON 化的快照结构。\r
\r
结构约定：\r
- 基本值:  {"t": "int|float|str|bool|None", "v": 值}\r
- 容器:    {"t": "list|tuple|dict|set", "id": 唯一id, "items": [元素快照...], "truncated": bool}\r
- numpy:   {"t": "ndarray", "id", "items": [展平元素快照...], "shape": [..], "truncated": bool}\r
- pandas:  {"t": "series", "id", "items": [[键,值]...], "name"} / {"t": "dataframe", "id", "columns", "rows", "shape"}\r
- 函数:    {"t": "function", "v": 名称}\r
- 其他:    {"t": "other", "v": repr 截断}\r
- 超深度:  {"t": "deep", "v": repr 截断}\r
\r
容器 id 用于前端重建引用箭头（同一 id = 同一对象）。\r
"""\r
\r
import types\r
\r
_PRIMITIVES = (int, float, str, bool, type(None))\r
\r
# 第三方库惰性加载缓存（子进程内未安装时优雅降级为 repr）\r
_LIB_CACHE: dict = {}\r
\r
\r
def _third_party():\r
    """返回 (numpy模块或None, pandas模块或None)。"""\r
    if 'done' not in _LIB_CACHE:\r
        try:\r
            import numpy as np\r
        except ImportError:\r
            np = None\r
        try:\r
            import pandas as pd\r
        except ImportError:\r
            pd = None\r
        _LIB_CACHE['done'] = True\r
        _LIB_CACHE['np'] = np\r
        _LIB_CACHE['pd'] = pd\r
    return _LIB_CACHE.get('np'), _LIB_CACHE.get('pd')\r
\r
\r
def _repr_cut(obj, limit: int) -> str:\r
    try:\r
        s = repr(obj)\r
    except Exception:\r
        s = '<unrepr-able>'\r
    return s if len(s) <= limit else s[: limit - 3] + '...'\r
\r
\r
# 无需闭合的 HTML 标签（缩进排版时不增加深度）\r
_HTML_VOID = {\r
    'meta', 'link', 'br', 'hr', 'img', 'input', 'area', 'base',\r
    'col', 'embed', 'source', 'track', 'wbr', 'param',\r
}\r
\r
\r
def _looks_like_html(s: str) -> bool:\r
    """形似 HTML 即独立建堆对象：看到文档头（<!doctype/<html）或完整标签结构"""\r
    st = s.lstrip()\r
    if not st.startswith('<'):\r
        return False\r
    low = st[:100].lower()\r
    if low.startswith('<!doctype') or low.startswith('<html'):\r
        return True\r
    # 完整标签结构兜底：<xxx>…</xxx> 形态\r
    return st.endswith('>') and '</' in st and len(st) >= 20\r
\r
\r
def _html_snap(text: str, oid: str, max_lines: int = 60) -> dict:\r
    """HTML 源码 → 编辑器式缩进行列表（标签间换行 + 深度缩进）。"""\r
    import re\r
\r
    t = text.strip()\r
    if len(t) > 20000:\r
        t = t[:20000]\r
    t = re.sub(r'>\\s*<', '>\\n<', t)  # 相邻标签之间换行（夹文本的行保持原样）\r
    lines: list[str] = []\r
    depth = 0\r
    truncated = False\r
    for raw in t.split('\\n'):\r
        line = raw.strip()\r
        if not line:\r
            continue\r
        if line.startswith('</'):\r
            depth = max(0, depth - 1)\r
        shown = line if len(line) <= 120 else line[:119] + '…'\r
        lines.append('  ' * min(depth, 12) + shown)\r
        m = re.match(r'<([a-zA-Z][a-zA-Z0-9]*)', line)\r
        if (\r
            m\r
            and not line.startswith('</')\r
            and not line.startswith('<!')\r
            and not line.endswith('/>')\r
            and m.group(1).lower() not in _HTML_VOID\r
            and '</' not in line\r
        ):\r
            depth += 1\r
        if len(lines) >= max_lines:\r
            truncated = True\r
            break\r
    return {\r
        't': 'html',\r
        'id': oid,\r
        'lines': lines,\r
        'truncated': truncated or None,\r
        'chars': len(text),\r
    }\r
\r
\r
def serialize(value, limits, _depth: int = 0) -> dict:\r
    """将任意对象序列化为快照 dict。"""\r
    max_depth = limits.max_depth\r
    max_container = limits.max_container\r
    max_repr = limits.max_repr\r
\r
    # 基本类型\r
    if isinstance(value, bool):\r
        return {'t': 'bool', 'v': value}\r
    if value is None:\r
        return {'t': 'None', 'v': None}\r
    if isinstance(value, int):\r
        return {'t': 'int', 'v': value}\r
    if isinstance(value, float):\r
        return {'t': 'float', 'v': value}\r
    if isinstance(value, str):\r
        if _looks_like_html(value):\r
            return _html_snap(value, _oid(value))\r
        return {'t': 'str', 'v': value}\r
\r
    # 第三方科学计算库（numpy 标量 → 原生数值；ndarray / Series / DataFrame → 专用快照）\r
    np, pd = _third_party()\r
    if np is not None and isinstance(value, np.generic):\r
        # numpy 标量（np.int64/np.float64 等）转原生值\r
        return serialize(value.item(), limits, _depth)\r
    if np is not None and isinstance(value, np.ndarray):\r
        try:\r
            flat = value.reshape(-1)\r
            items = [serialize(x, limits, _depth + 1) for x in flat[:max_container]]\r
            return {\r
                't': 'ndarray',\r
                'id': _oid(value),\r
                'items': items,\r
                'shape': [int(n) for n in value.shape],\r
                'truncated': value.size > max_container or None,\r
            }\r
        except Exception:\r
            pass  # 形状异常的对象数组 → repr 兜底\r
    if pd is not None:\r
        if isinstance(value, pd.DataFrame):\r
            try:\r
                columns = [str(c) for c in value.columns[:max_container]]\r
                rows = [\r
                    [serialize(v, limits, _depth + 1) for v in row]\r
                    for row in value.iloc[:max_container].itertuples(index=False, name=None)\r
                ]\r
                return {\r
                    't': 'dataframe',\r
                    'id': _oid(value),\r
                    'columns': columns,\r
                    'rows': rows,\r
                    'shape': [int(value.shape[0]), int(value.shape[1])],\r
                    'truncated': len(value) > max_container or None,\r
                }\r
            except Exception:\r
                pass\r
        if isinstance(value, pd.Series):\r
            try:\r
                pairs = list(value.items())[:max_container]\r
                return {\r
                    't': 'series',\r
                    'id': _oid(value),\r
                    'items': [\r
                        [serialize(k, limits, _depth + 1), serialize(v, limits, _depth + 1)]\r
                        for k, v in pairs\r
                    ],\r
                    'name': str(value.name) if value.name is not None else None,\r
                    'truncated': len(value) > max_container or None,\r
                }\r
            except Exception:\r
                pass\r
\r
    # requests.Response → 键值对快照（前端按 Response 对象卡渲染）\r
    if type(value).__name__ == 'Response' and hasattr(value, 'status_code') and hasattr(value, 'url'):\r
        try:\r
            text = value.text or ''\r
            # 乱码修复：未声明 charset 时 requests 默认 ISO-8859-1，\r
            # 用检测到的 apparent_encoding 重新解码（如 utf-8 页面）\r
            try:\r
                enc = (value.encoding or '').lower()\r
                app = value.apparent_encoding\r
                if enc in ('iso-8859-1', 'latin-1') and app and app.lower() not in (enc, 'iso-8859-1', 'latin-1'):\r
                    text = value.content.decode(app, errors='replace')\r
            except Exception:\r
                pass\r
\r
            def _pair(k, v):\r
                return [serialize(k, limits, _depth + 1), serialize(v, limits, _depth + 1)]\r
\r
            # text 为 HTML 时 → 指向独立 HTML 堆对象（引用箭头），否则内联截断文本\r
            if _looks_like_html(text):\r
                text_snap: dict = _html_snap(text, _oid(value) + 't')\r
            else:\r
                text_snap = {'t': 'str', 'v': text[: max_repr * 2] + ('...' if len(text) > max_repr * 2 else '')}\r
\r
            return {\r
                't': 'response',\r
                'id': _oid(value),\r
                'items': [\r
                    _pair('status_code', int(value.status_code)),\r
                    _pair('url', str(value.url)),\r
                    _pair('encoding', str(value.encoding)),\r
                    # text_snap 已是完整快照，直接放入（不可再经 serialize 包装）\r
                    [serialize('text', limits, _depth + 1), text_snap],\r
                ],\r
            }\r
        except Exception:\r
            pass  # 属性读取失败 → 走 repr 兜底\r
\r
    # 深度保护\r
    if _depth >= max_depth:\r
        return {'t': 'deep', 'v': _repr_cut(value, max_repr)}\r
\r
    # 容器\r
    if isinstance(value, (list, tuple, set)):\r
        items = list(value)\r
        truncated = len(items) > max_container\r
        shown = items[:max_container]\r
        if isinstance(value, set):\r
            shown = sorted((repr(i) for i in shown))\r
            ser_items = shown\r
        else:\r
            ser_items = [serialize(i, limits, _depth + 1) for i in shown]\r
        return {\r
            't': type(value).__name__,\r
            'id': _oid(value),\r
            'items': ser_items,\r
            'truncated': truncated or None,\r
        }\r
\r
    if isinstance(value, dict):\r
        pairs = list(value.items())\r
        truncated = len(pairs) > max_container\r
        shown = pairs[:max_container]\r
        ser_items = [\r
            [serialize(k, limits, _depth + 1), serialize(v, limits, _depth + 1)]\r
            for k, v in shown\r
        ]\r
        return {\r
            't': 'dict',\r
            'id': _oid(value),\r
            'items': ser_items,\r
            'truncated': truncated or None,\r
        }\r
\r
    # 函数 / 类 / 模块\r
    if isinstance(value, (types.FunctionType, types.BuiltinFunctionType, types.MethodType)):\r
        return {'t': 'function', 'v': getattr(value, '__name__', '<func>')}\r
    if isinstance(value, types.ModuleType):\r
        return {'t': 'module', 'v': value.__name__}\r
\r
    # 其他对象：repr 降级\r
    return {'t': 'other', 'v': _repr_cut(value, max_repr)}\r
\r
\r
def _oid(obj) -> str:\r
    return f'o{hex(id(obj))[2:]}'\r
`,E=`"""
轨迹采集运行器（Pyodide / Worker 版）。

与 backend/tracer/runner.py 的事件结构完全一致，差异仅在入口：
- 不读取文件、不启动子进程，代码字符串直接 compile/exec
- 事件按批（默认 50 条）经 emit_batch(json_str) 回调给 Worker

事件种类：
  call / line / return / exception / stdout / figure / finish / error

设计要点：
- 只追踪用户代码帧（co_filename == USER_FILE），忽略运行器与标准库帧
- line 事件仅发送“变化的变量”（与该帧上一次快照 diff），call 时发送全量
- 用户 sys.stdout 被替换为事件写出器，print 转为 stdout 事件
"""

import base64
import importlib.util
import io
import json
import sys

from limits import Limits
from serializer import serialize

USER_FILE = '<user>'
BATCH_SIZE = 50


class OutputLimitExceeded(Exception):
    pass


class StepLimitExceeded(Exception):
    pass


class CancelledInterrupt(KeyboardInterrupt):
    """外部中断（SharedArrayBuffer 信号）触发的取消。"""


class EventWriter:
    """把事件累积成批，调用 JS 回调批量输出。"""

    def __init__(self, emit_batch, limits: Limits, batch_size: int = BATCH_SIZE):
        self._emit_batch = emit_batch
        self._batch_size = batch_size
        self._buf: list[dict] = []
        self.seq = 0
        self.output_bytes = 0

    def emit(self, event: dict) -> None:
        self.seq += 1
        event['seq'] = self.seq
        self._buf.append(event)
        if len(self._buf) >= self._batch_size:
            self.flush()

    def flush(self) -> None:
        if not self._buf or self._emit_batch is None:
            return
        data = json.dumps(self._buf, ensure_ascii=False)
        del self._buf[:]
        self._emit_batch(data)

    def emit_stdout(self, text: str, limits: Limits) -> None:
        self.output_bytes += len(text.encode('utf-8', 'replace'))
        if self.output_bytes > limits.max_output:
            raise OutputLimitExceeded()
        self.emit({'kind': 'stdout', 'payload': text})


class StdoutProxy:
    def __init__(self, writer: EventWriter, limits: Limits):
        self.writer = writer
        self.limits = limits

    def write(self, s: str) -> int:
        self.writer.emit_stdout(s, self.limits)
        return len(s)

    def flush(self) -> None:
        pass

    def isatty(self) -> bool:
        return False


def make_tracer(writer: EventWriter, limits: Limits, user_file: str):
    """返回 sys.settrace 所需的 trace 函数。"""
    # 帧快照缓存: frame_id -> {varname: serialized}
    frame_snapshots: dict[int, dict] = {}
    steps = [0]

    def step_budget() -> bool:
        steps[0] += 1
        return steps[0] <= limits.max_steps

    def frame_vars(frame) -> dict:
        """取当前作用域变量。

        Python 3.12+ 内联推导式（PEP 709）执行期间，模块帧的 f_locals 只剩
        推导式自身变量，外层变量被遮蔽；此时与 f_globals 合并，保持与旧版
        Python 一致的观测结果。
        """
        loc = frame.f_locals
        if frame.f_code.co_name == '<module>' and loc is not frame.f_globals:
            merged = dict(frame.f_globals)
            merged.update(loc)
            return merged
        return loc

    def serialize_frame_locals(frame) -> dict:
        out = {}
        for name, val in frame_vars(frame).items():
            if name.startswith('__'):
                continue
            out[name] = serialize(val, limits)
        return out

    def diff_frame_locals(frame, frame_id: int) -> dict:
        cur = serialize_frame_locals(frame)
        prev = frame_snapshots.get(frame_id, {})
        changed = {k: v for k, v in cur.items() if prev.get(k) != v}
        # 变量被删除时也要通知
        for k in prev:
            if k not in cur:
                changed[k] = {'t': 'deleted', 'v': None}
        frame_snapshots[frame_id] = cur
        return changed

    def trace(frame, event, arg):
        if frame.f_code.co_filename != user_file:
            return None

        fid = id(frame)
        func_name = frame.f_code.co_name

        if event == 'call':
            if not step_budget():
                raise StepLimitExceeded()
            changed = diff_frame_locals(frame, fid)
            writer.emit({
                'kind': 'call',
                'frameId': f'f{fid}',
                'funcName': func_name,
                'lineno': frame.f_lineno,
                'changed': changed,
            })
            return trace

        if event == 'line':
            if not step_budget():
                raise StepLimitExceeded()
            changed = diff_frame_locals(frame, fid)
            ev = {
                'kind': 'line',
                'frameId': f'f{fid}',
                'funcName': func_name,
                'lineno': frame.f_lineno,
            }
            if changed:
                ev['changed'] = changed
            writer.emit(ev)
            return trace

        if event == 'return':
            writer.emit({
                'kind': 'return',
                'frameId': f'f{fid}',
                'funcName': func_name,
                'lineno': frame.f_lineno,
                'payload': serialize(arg, limits),
            })
            frame_snapshots.pop(fid, None)
            return trace

        if event == 'exception':
            exc_type, exc_val, _ = arg
            writer.emit({
                'kind': 'exception',
                'frameId': f'f{fid}',
                'funcName': func_name,
                'lineno': frame.f_lineno,
                'payload': {'type': exc_type.__name__, 'message': str(exc_val)},
            })
            return trace

        return trace

    return trace


def make_figure_emitter(writer: EventWriter, user_code: str):
    """matplotlib 图像捕获：plt.show() 时把打开的图逐张发为 figure 事件。

    - 仅当用户代码引用了 matplotlib 且运行时已加载时才预载 pyplot
    - 强制 Agg 后端（无显示器环境）
    - 返回 emit_figures()：结束时调用可兜底发出未经过 show() 的图
    """
    state = {'plt': None, 'emitted': set(), 'counter': 0}

    if 'matplotlib' in user_code:
        try:
            if importlib.util.find_spec('matplotlib') is not None:
                import matplotlib

                matplotlib.use('Agg')
                import matplotlib.pyplot as plt

                state['plt'] = plt

                def patched_show(*args, **kwargs):
                    emit_figures()

                plt.show = patched_show
        except Exception:
            state['plt'] = None

    def emit_figures() -> None:
        plt = state['plt']
        if plt is None:
            return
        for num in plt.get_fignums():
            if num in state['emitted']:
                continue
            state['emitted'].add(num)
            try:
                fig = plt.figure(num)
                # SVG 矢量输出；fonttype='path' 文字转矢量路径
                plt.rcParams['svg.fonttype'] = 'path'
                buf = io.BytesIO()
                fig.savefig(buf, format='svg', bbox_inches='tight')
                state['counter'] += 1
                writer.emit({
                    'kind': 'figure',
                    'payload': {
                        'name': f'图 {state["counter"]}',
                        'dataUrl': 'data:image/svg+xml;base64,' + base64.b64encode(buf.getvalue()).decode('ascii'),
                    },
                })
            except Exception:
                continue

    return emit_figures


def run_code(code: str, limits: Limits | None = None, emit_batch=None, is_cancelled=None) -> None:
    """执行用户代码并批量回传轨迹事件。

    emit_batch: 接收 JSON 字符串数组的 JS 回调
    is_cancelled: 可选的 JS 回调，返回 True 表示收到外部取消信号
    """
    limits = limits or Limits()
    writer = EventWriter(emit_batch, limits)
    real_out = sys.stdout
    sys.stdout = StdoutProxy(writer, limits)

    globs = {'__name__': '__main__', '__file__': USER_FILE, '__builtins__': __builtins__}

    try:
        try:
            compiled = compile(code, USER_FILE, 'exec')
        except SyntaxError as e:
            writer.emit({
                'kind': 'error',
                'payload': {'type': 'SyntaxError', 'message': f'{e.msg} (line {e.lineno})'},
            })
            return

        emit_figures = make_figure_emitter(writer, code)
        tracer = make_tracer(writer, limits, USER_FILE)

        try:
            sys.settrace(tracer)
            try:
                exec(compiled, globs)
                finish = {'kind': 'finish', 'payload': {'status': 'ok'}}
            except (OutputLimitExceeded, StepLimitExceeded) as e:
                name = 'OutputLimitExceeded' if isinstance(e, OutputLimitExceeded) else 'StepLimitExceeded'
                msg = '输出超过上限' if isinstance(e, OutputLimitExceeded) else '执行步数超过上限'
                finish = {'kind': 'finish', 'payload': {'status': 'limited', 'reason': name, 'message': msg}}
            except SystemExit:
                finish = {'kind': 'finish', 'payload': {'status': 'ok'}}
            except KeyboardInterrupt:
                cancelled = False
                if is_cancelled is not None:
                    try:
                        cancelled = bool(is_cancelled())
                    except Exception:
                        cancelled = False
                if cancelled:
                    finish = {'kind': 'finish', 'payload': {'status': 'cancelled'}}
                else:
                    finish = {'kind': 'finish', 'payload': {
                        'status': 'error', 'type': 'KeyboardInterrupt', 'message': 'KeyboardInterrupt',
                    }}
            except BaseException as e:  # 未捕获异常
                finish = {
                    'kind': 'finish',
                    'payload': {'status': 'error', 'type': type(e).__name__, 'message': str(e)},
                }
            finally:
                sys.settrace(None)
        finally:
            emit_figures()  # 兜底：未经过 show() 的图也在结束前发出

        writer.emit(finish)
    finally:
        sys.stdout = real_out
        writer.flush()
`;let r=null,o=null,d=null,c=null,i=null,u={...p},f=!1,_=Promise.resolve();function a(n){_=_.then(n).catch(e=>{t({type:"error",message:String(e&&e.stack||e)})})}function t(n){self.postMessage(n)}function N(n){return n.baseUrl?n.baseUrl.endsWith("/")?n.baseUrl:`${n.baseUrl}/`:new URL("./pyodide/",self.location.href).href}function S(n){n.mkdirTree("/wpt/scaffold"),n.writeFile("/wpt/limits.py",b),n.writeFile("/wpt/serializer.py",k),n.writeFile("/wpt/tracer.py",E),n.writeFile("/wpt/imports.py",x),n.writeFile("/wpt/scaffold/__init__.py",v),n.writeFile("/wpt/scaffold/placeholder.py",g),n.writeFile("/wpt/scaffold/skeleton.py",w)}async function I(n){if(r)return;u={...p,...n.limits??{}},t({type:"status",status:"connecting"});const e=performance.now(),l=N(n);r=await(await import(`${l}pyodide.mjs`)).loadPyodide({indexURL:l}),n.interruptBuffer&&(i=new Int32Array(n.interruptBuffer),Atomics.store(i,0,0),r.setInterruptBuffer(new Uint8Array(n.interruptBuffer))),S(r.FS),r.runPython(y),o=r.globals.get("run"),d=r.globals.get("scaffold"),c=r.globals.get("analyze"),t({type:"status",status:"connected",detail:`启动 ${Math.round(performance.now()-e)}ms`})}let s=[],m=0;function h(n=!1){if(!s.length||!n&&s.length<400&&performance.now()-m<30)return;const e=s;s=[],m=performance.now(),t({type:"events",events:e})}function L(){return i!==null&&Atomics.load(i,0)!==0}async function F(n){if(!r||!o)throw new Error("运行时尚未就绪");if(!n.trim()){t({type:"error",message:"代码为空"});return}i&&Atomics.store(i,0,0),f=!0,t({type:"status",status:"running"});try{try{await r.loadPackagesFromImports(n)}catch(e){console.warn("loadPackagesFromImports failed",e)}o(n,JSON.stringify(u),e=>{s.push(...JSON.parse(e)),h()},i?L:null)}finally{h(!0),f=!1}}function z(n){if(!r||!d)throw new Error("运行时尚未就绪");const e=JSON.parse(d(n)),l={type:"skeleton",ok:e.ok,nodes:e.nodes,holes:e.holes};e.error&&(l.error=e.error),t(l)}function A(n){if(!r||!c)throw new Error("运行时尚未就绪");t({type:"imports",...JSON.parse(c(n))})}self.onmessage=n=>{const e=n.data;if(!(!e||typeof e!="object"))switch(e.type){case"init":a(()=>I(e));break;case"run":a(()=>F(e.code??""));break;case"scaffold":a(async()=>z(e.code??""));break;case"analyze":a(async()=>A(e.code??""));break;case"cancel":f?i?(Atomics.store(i,0,2),t({type:"status",status:"cancel_requested"})):t({type:"status",status:"idle",detail:"当前环境需由宿主终止运行时"}):t({type:"status",status:"idle"});break}}})();
