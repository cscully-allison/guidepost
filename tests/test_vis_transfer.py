"""
Tests for how Guidepost ships the Arrow payload to the frontend.

Small payloads ride inline in the `_vis_data` trait. Payloads above
`_INLINE_MAX_BYTES` skip it (a single huge comm message is dropped by some
frontends, e.g. VS Code) and are pulled by the frontend in chunks via a
`request_vis_data` message.

    pytest tests/test_vis_transfer.py -v
"""

import json

import numpy as np
import pandas as pd
import pyarrow as pa
import pytest

from guidepost.guidepost import Guidepost


@pytest.fixture
def df():
    rng = np.random.default_rng(seed=3)
    n = 500
    return pd.DataFrame({
        "a": rng.exponential(10, n),
        "b": rng.gamma(2, 5, n),
        "c": rng.integers(1, 100, n).astype(float),
        "team": rng.choice(["x", "y", "z"], n),
        "queue": rng.choice(["s", "m", "l"], n),
    })


def _gp(df, inline_max=None, chunk=None):
    gp = Guidepost()
    gp.suppress_warnings = True
    if inline_max is not None:
        gp._INLINE_MAX_BYTES = inline_max
    if chunk is not None:
        gp._CHUNK_BYTES = chunk
    gp.records = df
    return gp


def _capture_sends(gp):
    sent = []
    gp.send = lambda content, buffers=None: sent.append((content, [bytes(b) for b in (buffers or [])]))
    return sent


def test_small_payload_is_inline(df):
    gp = _gp(df)
    assert gp._vis_transfer == "{}"
    assert gp._vis_data == gp.records
    assert len(gp._vis_data) > 0


def test_large_payload_skips_trait_and_announces_transfer(df):
    gp = _gp(df, inline_max=1024, chunk=4096)
    assert gp._vis_data == b""
    transfer = json.loads(gp._vis_transfer)
    assert transfer["size"] == len(gp.records) > 1024
    assert transfer["chunks"] == -(-transfer["size"] // 4096)
    assert transfer["id"] == gp._vis_transfer_id


def test_records_getter_returns_full_bytes_when_chunked(df):
    inline = _gp(df)
    chunked = _gp(df, inline_max=1024, chunk=4096)
    assert chunked.records == inline.records


def test_request_vis_data_streams_chunks_that_reassemble(df):
    gp = _gp(df, inline_max=1024, chunk=4096)
    sent = _capture_sends(gp)
    transfer = json.loads(gp._vis_transfer)
    gp._dispatch_custom_msg(gp, {"type": "request_vis_data", "request_id": "r1",
                                  "transfer_id": transfer["id"]}, [])
    assert len(sent) == transfer["chunks"]
    for i, (content, buffers) in enumerate(sent):
        assert content["type"] == "vis_data_chunk"
        assert content["request_id"] == "r1"
        assert (content["index"], content["total"]) == (i, transfer["chunks"])
        assert len(buffers) == 1
    payload = b"".join(buffers[0] for _, buffers in sent)
    assert payload == gp.records
    table = pa.ipc.open_stream(payload).read_all()
    assert table.num_rows == len(df)


def test_stale_transfer_id_replies_with_error(df):
    gp = _gp(df, inline_max=1024, chunk=4096)
    sent = _capture_sends(gp)
    stale = json.loads(gp._vis_transfer)["id"]
    gp.records = df  # a reload bumps the transfer id
    gp._dispatch_custom_msg(gp, {"type": "request_vis_data", "request_id": "r2",
                                  "transfer_id": stale}, [])
    assert len(sent) == 1
    content, _ = sent[0]
    assert content["type"] == "request_vis_data_error"
    assert content["request_id"] == "r2"
    assert "stale" in content["error"]


def test_switching_from_chunked_to_inline_resets_transfer(df):
    gp = _gp(df, inline_max=1024, chunk=4096)
    assert gp._vis_data == b""
    gp._INLINE_MAX_BYTES = 10 * 1024 * 1024
    gp.records = df
    assert gp._vis_transfer == "{}"
    assert gp._vis_data == gp.records
