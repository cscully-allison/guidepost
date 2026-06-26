"""
Co-occurrence seriation + association-aware selection for list-valued
categorical x columns (e.g. the HPC LOCATION node column).

For each declared list column this computes, once at load over the full frame:

- ``order``: a seriation sequence (spectral / Fiedler) so that nodes which
  frequently share jobs sit adjacent on the x-axis, revealing block structure.
- ``score``: a per-node "interestingness" score combining raw frequency with
  peak association to a *common* node, so the frontend column cap keeps frequent
  nodes AND rare-but-strongly-coupled nodes (a surprising-association insight)
  rather than dropping the latter for being infrequent.

Both derive from the same node x node co-occurrence matrix. sklearn/scipy are
imported lazily so the cost is only paid when a list column is present.
"""

import numpy as np

from .node_layout import compute_node_layout


def compute_category_ordering(o_df, list_columns):
    """Dispatch ordering per list column: prefer structure-aware node-name
    layout, fall back to spectral co-occurrence seriation.

    Returns ``{col: info}`` where *info* is either the structured shape
    ``{"order", "hierarchy", "levels"}`` (node names follow a hardware-layout
    convention) or the seriation shape ``{"order", "score"}`` (arbitrary
    categories). The frontend treats both uniformly via ``category_order`` and
    branches on the presence of ``category_hierarchy``.
    """
    if not list_columns:
        return {}

    out = {}
    fallback_cols = []
    for col in list_columns:
        if col not in o_df.columns:
            continue
        names = _distinct_node_names(o_df[col])
        layout = compute_node_layout(names) if names else None
        if layout is not None:
            out[col] = layout
        else:
            fallback_cols.append(col)

    if fallback_cols:
        out.update(compute_category_seriation(o_df, fallback_cols))
    return out


def _distinct_node_names(series):
    """Flatten a list-valued column's cells into the sorted distinct set of
    stringified node names (matching the String(value) keys the JS model uses)."""
    cells = [c for c in series.tolist() if isinstance(c, (list, tuple, np.ndarray))]
    return sorted({str(item) for cell in cells for item in cell if item is not None})


def compute_category_seriation(o_df, list_columns):
    """Returns {col: {"order": [node, ...], "score": {node: float}}} for each
    list column present in o_df. Empty/missing columns are skipped."""
    if not list_columns:
        return {}

    from scipy import sparse
    from scipy.sparse.csgraph import connected_components
    from sklearn.manifold import SpectralEmbedding

    out = {}
    for col in list_columns:
        if col not in o_df.columns:
            continue
        info = _seriate_column(o_df[col], sparse, connected_components, SpectralEmbedding)
        if info is not None:
            out[col] = info
    return out


def _seriate_column(series, sparse, connected_components, SpectralEmbedding):
    # Each non-null cell is a list of node names (already parsed + deduped
    # upstream); dedupe again defensively. Node names are stringified so they
    # match the String(value) keys the JS model builds its columns from.
    cells = [c for c in series.tolist() if isinstance(c, (list, tuple, np.ndarray))]
    node_list = sorted({str(item) for cell in cells for item in cell if item is not None})
    n_nodes = len(node_list)
    if n_nodes == 0:
        return None
    if n_nodes == 1:
        return {"order": list(node_list), "score": {node_list[0]: 1.0}}

    node_index = {n: i for i, n in enumerate(node_list)}
    rows, cols = [], []
    for j, cell in enumerate(cells):
        seen = set()
        for item in cell:
            if item is None:
                continue
            k = str(item)
            if k in seen:
                continue
            seen.add(k)
            rows.append(j)
            cols.append(node_index[k])
    data = np.ones(len(rows), dtype=np.float64)
    M = sparse.csr_matrix((data, (rows, cols)), shape=(len(cells), n_nodes))
    C = (M.T @ M).tocsr()                       # node x node co-occurrence
    freq = C.diagonal().astype(np.float64)      # diagonal = per-node job count

    score = _association_score(C, freq, n_nodes, node_list)
    order = _spectral_order(C, n_nodes, node_list, sparse, connected_components, SpectralEmbedding)
    return {"order": order, "score": score}


def _association_score(C, freq, n_nodes, node_list):
    # score_i = max(freq_norm_i, assoc_i) where
    #   assoc_i = max_{j != i} P(j | i) * freq_norm_j,  P(j | i) = C[i][j] / freq_i
    # P(j|i) is the *conditional* probability that partner j appears given node i
    # is used. This is what captures "whenever rare node B runs, common node A
    # also runs" (P(A|B) ~ 1) even though B is infrequent — symmetric Jaccard
    # would penalize that asymmetry. Weighting by the partner's normalized
    # frequency keeps high only couplings to a COMMON node, so two mutually-rare
    # nodes that always co-occur don't flood the cap.
    max_freq = freq.max() if freq.size else 1.0
    if max_freq <= 0:
        max_freq = 1.0
    freq_norm = freq / max_freq

    assoc = np.zeros(n_nodes, dtype=np.float64)
    Ccoo = C.tocoo()
    for i, j, c in zip(Ccoo.row, Ccoo.col, Ccoo.data):
        if i == j or freq[i] <= 0:
            continue
        val = (c / freq[i]) * freq_norm[j]
        if val > assoc[i]:
            assoc[i] = val

    score = np.maximum(freq_norm, assoc)
    return {node_list[i]: float(score[i]) for i in range(n_nodes)}


def _spectral_order(C, n_nodes, node_list, sparse, connected_components, SpectralEmbedding):
    # Affinity = co-occurrence with the diagonal removed.
    A = C.tolil()
    A.setdiag(0)
    A = A.tocsr()
    A.eliminate_zeros()

    # Spectral embedding degenerates on disconnected graphs, so seriate each
    # connected component independently and concatenate.
    _, labels = connected_components(A, directed=False)
    comp_members = {}
    for idx, lab in enumerate(labels):
        comp_members.setdefault(lab, []).append(idx)

    sequences = [
        _seriate_component(members, A, node_list, SpectralEmbedding)
        for members in comp_members.values()
    ]
    # Larger (more structured) components first; deterministic tie-break by name.
    sequences.sort(key=lambda seq: (-len(seq), node_list[seq[0]]))
    return [node_list[idx] for seq in sequences for idx in seq]


def _seriate_component(members, A, node_list, SpectralEmbedding):
    if len(members) <= 2:
        return sorted(members, key=lambda i: node_list[i])

    sub = A[members][:, members].toarray()

    # On symmetric structures (e.g. a clique) the smallest non-zero Laplacian
    # eigenvalue is degenerate, so the 1-D spectral coordinate is not unique:
    # the eigensolver returns an arbitrary basis vector from that eigenspace,
    # which varies across runs, platforms, and BLAS threading. There is no
    # canonical order in that case, so fall back to deterministic name order.
    # (EigenVALUES are stable even when the corresponding eigenVECTORS are not,
    # so this test is itself reproducible.)
    if _spectral_order_is_degenerate(sub):
        return sorted(members, key=lambda i: node_list[i])

    emb = SpectralEmbedding(n_components=1, affinity="precomputed", random_state=0)
    coords = emb.fit_transform(sub)[:, 0]
    # Round so any residual floating-point noise on near-tied nodes collapses and
    # the name-based secondary key decides their order deterministically.
    local = sorted(
        range(len(members)),
        key=lambda t: (round(float(coords[t]), 9), node_list[members[t]]),
    )
    seq = [members[t] for t in local]
    # Eigenvectors carry a sign ambiguity; canonicalize orientation by name.
    if node_list[seq[0]] > node_list[seq[-1]]:
        seq.reverse()
    return seq


def _spectral_order_is_degenerate(sub, tol=1e-9):
    """True when the 1-D spectral embedding of ``sub`` is ill-defined.

    The seriation uses the eigenvector of the smallest non-zero eigenvalue of
    the symmetric normalized Laplacian. When that eigenvalue is (near-)repeated,
    the eigenvector — and hence the node order — is not unique. We detect that
    from the eigenvalue *spectrum*, which ``eigvalsh`` returns deterministically
    regardless of solver/threading, unlike the eigenvectors themselves.
    """
    deg = sub.sum(axis=1)
    if np.any(deg <= 0):
        return True  # an isolated node has no meaningful spectral position
    d_inv_sqrt = 1.0 / np.sqrt(deg)
    laplacian = np.eye(sub.shape[0]) - (d_inv_sqrt[:, None] * sub * d_inv_sqrt[None, :])
    evals = np.linalg.eigvalsh(laplacian)  # ascending; evals[0] ~ 0 (connected)
    if len(evals) < 3:
        return False
    # Degenerate iff the 2nd and 3rd smallest eigenvalues coincide, i.e. the
    # smallest non-zero eigenvalue has multiplicity > 1.
    return bool((evals[2] - evals[1]) < tol)
