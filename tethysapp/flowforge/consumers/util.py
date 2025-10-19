
def _slug(x: str) -> str:
    import re
    return re.sub(r"[^a-zA-Z0-9\-]+", "-", str(x)).strip("-").lower() or "n"

def _kind_tag(kind_or_label: str) -> str:
    k = (kind_or_label or "").lower()
    # normalize a few variants we've seen in the UI
    if "pre-process" in k or "preprocess" in k:
        return "pre"
    if "calibration-config" in k:
        return "cal_cfg"
    if "calibration-run" in k:
        return "cal_run"
    if "teehr" in k:
        return "teehr"
    if ("ngiab" in k) and ("run" in k):
        return "run"
    return "other"

def _allowed_parent(parent_tag: str, child_tag: str) -> bool:
    # Stage-to-stage rules:
    # pre -> cal_cfg -> cal_run -> run -> teehr
    if child_tag == "cal_cfg":
        return parent_tag == "pre"
    if child_tag == "cal_run":
        return parent_tag == "cal_cfg"
    if child_tag == "run":
        # run can take from cal_run, or (fallbacks) cal_cfg, pre
        return parent_tag in ("cal_run", "cal_cfg", "pre")
    if child_tag == "teehr":
        return parent_tag == "run"
    # default: no constraints
    return True

def _parent_preference_order(tag: str) -> int:
    # Smaller number == stronger preference when multiple valid parents exist
    # Used only for the 'run' stage to choose cal_run over cal_cfg over pre
    order = {"cal_run": 0, "cal_cfg": 1, "pre": 2, "run": 0, "other": 9}
    return order.get(tag, 9)

def _normalize_edges(edges_in) -> list[tuple[str, str]]:
    """Accept either [{'source': 'a', 'target': 'b'}, ...] or [('a','b'), ...]."""
    out: list[tuple[str, str]] = []
    for e in edges_in or []:
        if isinstance(e, dict):
            s, t = e.get("source"), e.get("target")
        elif isinstance(e, (list, tuple)) and len(e) >= 2:
            s, t = e[0], e[1]
        else:
            continue
        if s is not None and t is not None:
            out.append((str(s), str(t)))
    return out

def _topo_layers(nodes: list[dict], edges: list) -> list[list[str]]:
    """Topological layering; edges can be normalized tuples or dicts."""
    # normalize edges first
    e2 = _normalize_edges(edges)
    ids = [str(n["id"]) for n in nodes]
    indeg = {i: 0 for i in ids}
    adj = {i: [] for i in ids}
    for (s, t) in e2:
        if s in adj and t in indeg:
            adj[s].append(t)
            indeg[t] += 1
    layers, frontier = [], [i for i in ids if indeg[i] == 0]
    seen = set()
    while frontier:
        layers.append(frontier[:])
        seen.update(frontier)
        nxt = []
        for u in frontier:
            for v in adj[u]:
                indeg[v] -= 1
                if indeg[v] == 0 and v not in seen:
                    nxt.append(v)
        frontier = nxt
    # Any nodes not reached (e.g. cyclic or isolated) go into a last layer
    if len(seen) != len(ids):
        layers.append([i for i in ids if i not in seen])
    return layers