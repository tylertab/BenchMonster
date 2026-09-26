from app.runner import _shares, split_batch


def test_split_batch_accepts_fenced_arrays_and_wrapped_objects():
    assert split_batch('```json\n[{"a": 1}, "two"]\n```', 2) == ['{"a": 1}', "two"]
    assert split_batch('Here you go: [{"a": 1}, {"b": 2}]', 2) == ['{"a": 1}', '{"b": 2}']
    assert split_batch('{"answers": ["x", "y"]}', 2) == ["x", "y"]


def test_split_batch_rejects_wrong_shapes():
    assert split_batch('["x"]', 2) is None
    assert split_batch("not json", 1) is None
    assert split_batch('{"a": ["x"], "b": ["y"]}', 1) is None


def test_shares_split_exactly():
    assert _shares(10, 3) == [4, 3, 3]
    assert sum(_shares(101, 7)) == 101
    assert _shares(None, 2) == [None, None]
