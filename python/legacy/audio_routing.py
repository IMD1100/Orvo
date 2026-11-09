"""Single-source audio routing shared by the planner, editor and renderer."""
from collections import deque
import copy
import re

INPUT, OUTPUT = "@input", "@output"
MAX_MIXERS = 8
MAX_LINKS = 96
MIN_GAIN_DB, MAX_GAIN_DB = -60, 12
POSITION_LIMIT = 1_000_000


class RoutingError(ValueError):
    def __init__(self, node, reason):
        self.node = node
        self.reason = reason
        super().__init__(f"{node}：{reason}")


def link(source, target, gain_db=0):
    return {"source": source, "target": target, "gain_db": gain_db}


def graph_plan(plan):
    """Make the implicit series routing of a normalized legacy plan explicit."""
    result = copy.deepcopy(plan)
    if result.get("schema_version") == 3:
        return result
    nodes = [INPUT, *(item["id"] for item in result["chain"]), OUTPUT]
    result["schema_version"] = 3
    result["routing"] = {
        "mixers": [],
        "links": [link(source, target) for source, target in zip(nodes, nodes[1:])],
        "positions": {},
    }
    return result


def validate_routing(plan, *, draft=False):
    """Return topological node order and incoming edges, or raise on bad routes."""
    routing = plan.get("routing")
    if not isinstance(routing, dict) or set(routing) - {"mixers", "links", "positions"}:
        raise ValueError("蓝图缺少有效路由。")
    mixers, edges = routing.get("mixers"), routing.get("links")
    if not isinstance(mixers, list) or len(mixers) > MAX_MIXERS:
        raise ValueError(f"蓝图最多支持 {MAX_MIXERS} 个汇合节点。")
    effects = [item.get("id") for item in plan["chain"]]
    if any(node is None for node in effects):
        raise ValueError("蓝图的每个效果器需要唯一 ID。")
    if any(not isinstance(node, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", node) for node in mixers):
        raise ValueError("汇合节点 ID 无效。")
    nodes = [INPUT, *effects, *mixers, OUTPUT]
    if len(nodes) != len(set(nodes)):
        raise ValueError("蓝图节点 ID 重复。")
    if not isinstance(edges, list) or len(edges) > MAX_LINKS:
        raise ValueError(f"蓝图最多支持 {MAX_LINKS} 条连线。")

    incoming = {node: [] for node in nodes}
    outgoing = {node: [] for node in nodes}
    seen = set()
    for edge in edges:
        if not isinstance(edge, dict) or set(edge) != {"source", "target", "gain_db"}:
            raise ValueError("每条连线必须包含来源、目标和电平。")
        source, target, gain = edge["source"], edge["target"], edge["gain_db"]
        if (not isinstance(source, str) or not isinstance(target, str)
                or source not in outgoing or target not in incoming
                or source == OUTPUT or target == INPUT or source == target):
            raise ValueError("连线方向或端口无效。")
        if (source, target) in seen:
            raise ValueError("这两个端口已经连接。")
        if type(gain) not in (int, float) or not MIN_GAIN_DB <= gain <= MAX_GAIN_DB:
            raise ValueError(f"支路电平须在 {MIN_GAIN_DB} 至 {MAX_GAIN_DB} dB 之间。")
        if target not in mixers and gain != 0:
            raise ValueError("支路电平只可在汇合节点的入口调节。")
        seen.add((source, target))
        incoming[target].append(edge)
        outgoing[source].append(target)

    degrees = {node: len(edges) for node, edges in incoming.items()}
    if any(degrees[node] > 1 for node in (*effects, OUTPUT)):
        raise ValueError("效果器和输出只能接入一路音频；多路音频请先接到汇合节点。")
    pending = deque(node for node in nodes if degrees[node] == 0)
    order = []
    while pending:
        node = pending.popleft()
        order.append(node)
        for target in outgoing[node]:
            degrees[target] -= 1
            if not degrees[target]:
                pending.append(target)
    if len(order) != len(nodes):
        raise ValueError("连线形成了环路。")

    positions = routing.get("positions", {})
    if not isinstance(positions, dict) or any(
        node not in incoming or not isinstance(point, list) or len(point) != 2
        or any(type(coord) not in (int, float) or not -POSITION_LIMIT <= coord <= POSITION_LIMIT for coord in point)
        for node, point in positions.items()
    ):
        raise ValueError("节点位置无效。")
    if not draft:
        for node in nodes:
            if node != INPUT and not incoming[node]:
                raise RoutingError(node, "缺少输入连线。")
            if node != OUTPUT and not outgoing[node]:
                raise RoutingError(node, "缺少输出连线。")
            if node in mixers and len(incoming[node]) < 2:
                raise RoutingError(node, "至少需要两路输入。")
    return order, incoming


def signal_signature(plan):
    """Compare audio edits independently of node coordinates or display order."""
    graph = graph_plan(plan)
    route = graph["routing"]
    return (sorted(graph["chain"], key=lambda item: item["id"]),
            sorted(route["mixers"]),
            sorted(route["links"], key=lambda edge: (edge["source"], edge["target"])))
