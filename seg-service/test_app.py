from app import parse_statistics


def test_parse_statistics_tri_et_arrondi():
    stats = {
        "liver": {"volume": 1500.234},
        "kidney_left": {"volume": 140.05},
        "rib_left_1": {"volume": 0.0},
    }
    out = parse_statistics(stats)
    assert out[0] == {"name": "liver", "volumeMl": 1500.2}
    assert out[1] == {"name": "kidney_left", "volumeMl": 140.1}
    assert all(s["name"] != "rib_left_1" for s in out)


def test_parse_statistics_entrees_invalides():
    # Structures sans volume numérique → ignorées, jamais d'exception.
    assert parse_statistics({}) == []
    assert parse_statistics({"x": {}}) == []
    assert parse_statistics({"x": {"volume": "n/a"}}) == []
