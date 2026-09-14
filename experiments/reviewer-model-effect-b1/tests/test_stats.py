import math

import numpy as np

from stats import cluster_bootstrap_ci, logistic_regression, ols_hc1, wilson_ci


def test_ols_coefficients_match_hand_worked_line():
    x = np.array([[1.0, 0.0], [1.0, 1.0], [1.0, 2.0], [1.0, 3.0]])
    y = np.array([1.0, 3.0, 5.0, 7.0])
    result = ols_hc1(y, x, ["Intercept", "x"])
    assert np.allclose(result.coef, [1.0, 2.0])
    assert result.n == 4


def test_ols_hc1_standard_error_small_fixture():
    x = np.array([[1.0, 0.0], [1.0, 1.0], [1.0, 2.0], [1.0, 3.0], [1.0, 4.0]])
    y = np.array([1.0, 2.0, 2.0, 5.0, 4.0])
    result = ols_hc1(y, x, ["Intercept", "x"])
    assert np.allclose(result.coef, [1.0, 0.9])
    assert math.isclose(result.se[1], 0.2287647992, rel_tol=1e-6)


def test_wilson_interval_matches_reference_value():
    low, high = wilson_ci(5, 20)
    assert math.isclose(low, 0.1118617014, rel_tol=1e-6)
    assert math.isclose(high, 0.4687008776, rel_tol=1e-6)


def test_bootstrap_ci_covers_known_synthetic_mean():
    values = np.array([0.9, 1.0, 1.1, 0.95, 1.05, 1.0])
    groups = np.array(["a", "b", "c", "d", "e", "f"])
    low, high = cluster_bootstrap_ci(values, groups, np.mean, iterations=300, seed=123)
    assert low < 1.0 < high


def test_logistic_regression_recovers_positive_direction():
    x = np.array(
        [
            [1.0, 0.0],
            [1.0, 0.0],
            [1.0, 1.0],
            [1.0, 1.0],
            [1.0, 2.0],
            [1.0, 2.0],
        ]
    )
    y = np.array([0, 0, 0, 1, 1, 1])
    result = logistic_regression(y, x, ["Intercept", "x"])
    assert result.coef[1] > 0
