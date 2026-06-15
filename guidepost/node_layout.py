"""
Structure-aware ordering for list-valued categorical x columns whose values are
HPC compute-node names following a hardware-layout convention (e.g. the Cray
XName scheme ``x{cabinet}c{chassis}s{slot}b{blade}n{node}`` used by both Kestrel
``nodelist`` and Polaris ``LOCATION``).

When the node names parse cleanly into a sequence of (alpha-prefix, integer)
segments of uniform depth, we can order the x-axis by *physical layout* — cabinet
then chassis then slot... — instead of by co-occurrence seriation, and we get a
nesting hierarchy (cabinet > chassis > slot > ...) for free. The frontend uses
that hierarchy to render an adaptive grouped overview and a focus+context lens
*without dropping any nodes*.

This is intentionally convention-aware but not convention-locked: the parser
accepts any clean alpha/integer segmentation; only the human-readable level
*labels* know about the Cray prefixes, with a generic fallback. When names don't
parse (arbitrary categories), ``compute_node_layout`` returns ``None`` and the
caller falls back to spectral seriation.
"""

import re

_SEG = re.compile(r"([A-Za-z]+)(\d+)")

# Human-readable labels for known Cray XName segment prefixes, by position-prefix.
# Anything not listed falls back to a generic "level N" label.
_CRAY_LEVEL_LABELS = {
    "x": "cabinet",
    "c": "chassis",
    "s": "slot",
    "b": "blade",
    "n": "node",
}


def parse_node_name(name):
    """Parse ``'x1008c0s0b1n1'`` into ``[('x', 1008), ('c', 0), ('s', 0),
    ('b', 1), ('n', 1)]``.

    Returns ``None`` when *name* is not a clean, gap-free sequence of
    alpha-prefix + integer segments (e.g. ``'queue-a'``, ``'x'``, ``''``,
    ``'x1c'``). The whole string must be consumed by segments and at least one
    segment must be present.
    """
    s = str(name)
    segs = []
    pos = 0
    for m in _SEG.finditer(s):
        if m.start() != pos:  # a gap (stray char) => not structured
            return None
        segs.append((m.group(1), int(m.group(2))))
        pos = m.end()
    if pos != len(s) or not segs:
        return None
    return segs


def detect_structured(node_list, min_match_rate=0.95):
    """Decide whether *node_list* follows a parseable layout convention.

    Returns ``(is_structured, parsed_map, prefixes)`` where ``parsed_map`` maps
    each parseable name to its segment list and ``prefixes`` is the common
    prefix sequence (e.g. ``['x', 'c', 's', 'b', 'n']``) when names share a
    uniform depth and prefix sequence, else ``None``.

    Structured requires: match rate >= *min_match_rate*, AND the matched names
    share a single uniform (depth, prefix-sequence). Mixed conventions or ragged
    depths fall back to seriation rather than guess a hierarchy.
    """
    parsed_map = {}
    prefix_seqs = {}
    for name in node_list:
        segs = parse_node_name(name)
        if segs is None:
            continue
        parsed_map[name] = segs
        prefix_seqs[tuple(p for p, _ in segs)] = prefix_seqs.get(tuple(p for p, _ in segs), 0) + 1

    total = len(node_list)
    if total == 0:
        return False, {}, None
    match_rate = len(parsed_map) / total
    if match_rate < min_match_rate:
        return False, parsed_map, None

    # Require a single dominant prefix sequence (uniform depth + prefixes).
    dominant = max(prefix_seqs, key=prefix_seqs.get)
    if prefix_seqs[dominant] / len(parsed_map) < min_match_rate:
        return False, parsed_map, None

    # Keep only names matching the dominant prefix sequence so the hierarchy is
    # rectangular; re-check the match rate against the full list.
    parsed_map = {
        n: segs for n, segs in parsed_map.items()
        if tuple(p for p, _ in segs) == dominant
    }
    if len(parsed_map) / total < min_match_rate:
        return False, parsed_map, None

    return True, parsed_map, list(dominant)


def _level_labels(prefixes):
    """Map a prefix sequence to human-readable per-level labels, using the Cray
    names where recognized and a generic ``"<prefix> level"`` otherwise."""
    return [_CRAY_LEVEL_LABELS.get(p, f"{p} level") for p in prefixes]


def compute_node_layout(node_list, min_match_rate=0.95):
    """Primary entry point for structure-aware ordering.

    Returns ``None`` when *node_list* is not structured enough (caller should
    fall back to seriation). Otherwise returns::

        {
            "order":     [name, ...],            # numeric-aware topological sort
            "hierarchy": {name: [g0, g1, ..., leaf]},  # cumulative group key per level
            "levels":    ["cabinet", "chassis", ...],  # human label per hierarchy level
        }

    The group key at level L is the cumulative XName prefix through segment L
    (``'x1008'``, ``'x1008c0'``, ...), so each level's key is a string-prefix of
    the next — a clean nesting the frontend relies on. The leaf key is the full
    node name. The number of *grouping* levels is one less than the segment
    depth: the deepest segment distinguishes individual nodes (the leaves).
    """
    names = sorted({str(n) for n in node_list if n is not None})
    is_structured, parsed_map, prefixes = detect_structured(names, min_match_rate)
    if not is_structured:
        return None

    # Numeric-aware topological sort: order by the tuple of segment integers so
    # x1009 < x1010 (not lexicographic x100 < x1009), cabinet-major. Names that
    # didn't match the dominant prefix sequence are appended in name order so
    # nothing is silently lost.
    matched = [n for n in names if n in parsed_map]
    unmatched = [n for n in names if n not in parsed_map]
    matched.sort(key=lambda n: tuple(num for _p, num in parsed_map[n]))
    order = matched + sorted(unmatched)

    depth = len(prefixes)
    # Grouping levels = all but the leaf segment; if depth == 1 there is a single
    # (degenerate) level keyed by the name itself.
    n_levels = max(depth - 1, 1)
    levels = _level_labels(prefixes[:n_levels])

    hierarchy = {}
    for n in matched:
        segs = parsed_map[n]
        keys = []
        cumulative = ""
        for li in range(n_levels):
            prefix, num = segs[li]
            cumulative += f"{prefix}{num}"
            keys.append(cumulative)
        keys.append(n)  # leaf = full node name
        hierarchy[n] = keys
    # Unmatched names sit at every level under their own name (singleton groups).
    for n in unmatched:
        hierarchy[n] = [n] * (n_levels + 1)

    return {"order": order, "hierarchy": hierarchy, "levels": levels}
