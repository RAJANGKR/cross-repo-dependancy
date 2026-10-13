"""Cross-repository dependency graph, built with networkx."""
from typing import List

import networkx as nx

_DISPARITY_RANK = {"MAJOR_DRIFT": 3, "MINOR_DRIFT": 2, "INFO": 1, "IN_SYNC": 0}


def build_graph(drift_matrix: List[dict]) -> nx.DiGraph:
    """Repository -> package edges, one per declaration."""
    graph = nx.DiGraph()
    for row in drift_matrix:
        graph.add_node(row["id"], kind="package", drift=row["drift_disparity"])
        for repo, declaration in row["declarations_by_repo"].items():
            graph.add_node(f"repo:{repo}", kind="repo")
            graph.add_edge(
                f"repo:{repo}",
                row["id"],
                declared_spec=declaration["declared_range"],
                resolved_version=declaration["resolved_version"],
                dep_type=declaration["dep_type"],
                source_file=declaration["source_file"],
            )
    return graph


def summarize(drift_matrix: List[dict], top: int = 5) -> dict:
    graph = build_graph(drift_matrix)
    drifted = [row for row in drift_matrix if row["drift_disparity"] in ("MAJOR_DRIFT", "MINOR_DRIFT")]
    drifted.sort(key=lambda row: (-_DISPARITY_RANK[row["drift_disparity"]], -graph.in_degree(row["id"]), row["dependency_name"]))
    return {
        "total_nodes": graph.number_of_nodes(),
        "total_edges": graph.number_of_edges(),
        "density": round(nx.density(graph), 4),
        "highest_drift_nodes": [row["dependency_name"] for row in drifted[:top]],
    }
