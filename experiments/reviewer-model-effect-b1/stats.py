from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
from scipy import optimize, stats as scipy_stats


@dataclass(frozen=True)
class RegressionResult:
    names: list[str]
    coef: np.ndarray
    se: np.ndarray
    ci_low: np.ndarray
    ci_high: np.ndarray
    p_value: np.ndarray
    n: int

    def as_dict(self) -> dict[str, dict[str, float]]:
        return {
            name: {
                "estimate": float(self.coef[index]),
                "se": float(self.se[index]),
                "ci_low": float(self.ci_low[index]),
                "ci_high": float(self.ci_high[index]),
                "p_value": float(self.p_value[index]),
            }
            for index, name in enumerate(self.names)
        }


def ols_hc1(y: np.ndarray, x: np.ndarray, names: list[str]) -> RegressionResult:
    y = np.asarray(y, dtype=float)
    x = np.asarray(x, dtype=float)
    if x.ndim != 2:
        raise ValueError("x must be a 2D matrix")
    if len(y) != x.shape[0]:
        raise ValueError("y and x row counts differ")
    if x.shape[1] != len(names):
        raise ValueError("names length must match x columns")
    if x.shape[0] <= x.shape[1]:
        raise ValueError("OLS requires more rows than parameters")

    xtx_inv = np.linalg.pinv(x.T @ x)
    coef = xtx_inv @ x.T @ y
    residuals = y - x @ coef
    meat = x.T @ ((residuals[:, None] ** 2) * x)
    n, k = x.shape
    hc1_scale = n / max(n - k, 1)
    cov = hc1_scale * xtx_inv @ meat @ xtx_inv
    se = np.sqrt(np.maximum(np.diag(cov), 0.0))
    return _regression_result(names, coef, se, n)


def logistic_regression(
    y: np.ndarray,
    x: np.ndarray,
    names: list[str],
    ridge: float = 1e-6,
    maxiter: int = 500,
) -> RegressionResult:
    y = np.asarray(y, dtype=float)
    x = np.asarray(x, dtype=float)
    if set(np.unique(y)) - {0.0, 1.0}:
        raise ValueError("logistic_regression expects a binary outcome")
    if x.shape[0] <= x.shape[1]:
        raise ValueError("logistic regression requires more rows than parameters")

    penalty_mask = np.ones(x.shape[1])
    penalty_mask[0] = 0.0

    def objective(beta: np.ndarray) -> tuple[float, np.ndarray]:
        eta = np.clip(x @ beta, -35, 35)
        p = _sigmoid(eta)
        loss = -np.sum(y * np.log(p + 1e-12) + (1 - y) * np.log(1 - p + 1e-12))
        loss += 0.5 * ridge * np.sum(penalty_mask * beta**2)
        grad = x.T @ (p - y) + ridge * penalty_mask * beta
        return float(loss), grad

    result = optimize.minimize(
        lambda beta: objective(beta)[0],
        np.zeros(x.shape[1]),
        jac=lambda beta: objective(beta)[1],
        method="BFGS",
        options={"maxiter": maxiter, "gtol": 1e-7},
    )
    if not result.success:
        stronger = min(max(ridge * 1000, 1e-3), 1.0)
        if stronger == ridge:
            raise RuntimeError(f"logistic regression failed: {result.message}")
        return logistic_regression(y, x, names, ridge=stronger, maxiter=maxiter)

    coef = result.x
    p = _sigmoid(np.clip(x @ coef, -35, 35))
    weights = p * (1 - p)
    hessian = x.T @ (weights[:, None] * x) + ridge * np.diag(penalty_mask)
    cov = np.linalg.pinv(hessian)
    se = np.sqrt(np.maximum(np.diag(cov), 0.0))
    return _regression_result(names, coef, se, len(y))


def wilson_ci(successes: int, n: int, confidence: float = 0.95) -> tuple[float, float]:
    if n <= 0:
        return (float("nan"), float("nan"))
    z = scipy_stats.norm.ppf(1 - (1 - confidence) / 2)
    phat = successes / n
    denom = 1 + z**2 / n
    center = (phat + z**2 / (2 * n)) / denom
    half = z * np.sqrt((phat * (1 - phat) + z**2 / (4 * n)) / n) / denom
    return float(center - half), float(center + half)


def cluster_bootstrap_ci(
    values: np.ndarray,
    groups: np.ndarray,
    statistic_fn: Callable[[np.ndarray], float],
    iterations: int = 1000,
    confidence: float = 0.95,
    seed: int = 8675309,
) -> tuple[float, float]:
    values = np.asarray(values)
    groups = np.asarray(groups)
    if len(values) != len(groups):
        raise ValueError("values and groups must have equal length")
    unique_groups = np.unique(groups)
    if len(unique_groups) == 0:
        return (float("nan"), float("nan"))

    rng = np.random.default_rng(seed)
    estimates = []
    for _ in range(iterations):
        sampled_groups = rng.choice(unique_groups, size=len(unique_groups), replace=True)
        mask_parts = [np.flatnonzero(groups == group) for group in sampled_groups]
        indices = np.concatenate(mask_parts)
        estimates.append(statistic_fn(values[indices]))

    alpha = (1 - confidence) / 2
    return (
        float(np.quantile(estimates, alpha)),
        float(np.quantile(estimates, 1 - alpha)),
    )


def multinomial_propensity(
    treatment: np.ndarray,
    x: np.ndarray,
    classes: list[str],
    ridge: float = 1e-4,
) -> np.ndarray:
    treatment = np.asarray(treatment)
    x = np.asarray(x, dtype=float)
    if len(classes) < 2:
        raise ValueError("at least two treatment classes are required")
    class_to_index = {name: idx for idx, name in enumerate(classes)}
    y = np.array([class_to_index[value] for value in treatment], dtype=int)
    n, p = x.shape
    k = len(classes)

    def unpack(theta: np.ndarray) -> np.ndarray:
        beta = np.zeros((k, p))
        beta[1:] = theta.reshape(k - 1, p)
        return beta

    def objective(theta: np.ndarray) -> tuple[float, np.ndarray]:
        beta = unpack(theta)
        logits = x @ beta.T
        logits -= logits.max(axis=1, keepdims=True)
        exp_logits = np.exp(logits)
        probs = exp_logits / exp_logits.sum(axis=1, keepdims=True)
        loss = -np.log(probs[np.arange(n), y] + 1e-12).sum() + 0.5 * ridge * np.sum(theta**2)
        indicator = np.zeros_like(probs)
        indicator[np.arange(n), y] = 1.0
        grad_full = (probs - indicator).T @ x
        grad = grad_full[1:].reshape(-1) + ridge * theta
        return float(loss), grad

    result = optimize.minimize(
        lambda theta: objective(theta)[0],
        np.zeros((k - 1) * p),
        jac=lambda theta: objective(theta)[1],
        method="BFGS",
        options={"maxiter": 500, "gtol": 1e-7},
    )
    if not result.success:
        raise RuntimeError(f"multinomial propensity fit failed: {result.message}")

    beta = unpack(result.x)
    logits = x @ beta.T
    logits -= logits.max(axis=1, keepdims=True)
    exp_logits = np.exp(logits)
    return exp_logits / exp_logits.sum(axis=1, keepdims=True)


def _regression_result(names: list[str], coef: np.ndarray, se: np.ndarray, n: int) -> RegressionResult:
    z = np.divide(coef, se, out=np.zeros_like(coef), where=se > 0)
    p_value = 2 * (1 - scipy_stats.norm.cdf(np.abs(z)))
    ci_low = coef - 1.96 * se
    ci_high = coef + 1.96 * se
    return RegressionResult(names=list(names), coef=coef, se=se, ci_low=ci_low, ci_high=ci_high, p_value=p_value, n=n)


def _sigmoid(value: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-value))
