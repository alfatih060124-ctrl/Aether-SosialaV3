#!/usr/bin/env python3
"""Read-only, fail-closed LIVE preflight for AETHER.

This script never enables LIVE, mutates environment variables, writes runtime state,
or contacts the network. It only validates a non-secret evidence manifest plus the
current safety-gate environment and exits 0 when every prerequisite is satisfied.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
MIN_POSITIVE_FIXTURES = 30
MIN_NEGATIVE_FIXTURES = 10
REQUIRED_DEX_FAMILIES = {"jupiter", "raydium", "orca"}
PLACEHOLDER_VERSION_MARKERS = ("replace", "unset", "unknown", "placeholder", "any")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
FORBIDDEN_KEY_PARTS = (
    "private_key",
    "privatekey",
    "seed_phrase",
    "seedphrase",
    "mnemonic",
    "signing_key",
    "signingkey",
    "secret_key",
    "secretkey",
    "api_token",
    "admin_api_token",
    "auth_token",
    "bearer_token",
    "password",
    "passphrase",
)


def fail(reason: str) -> dict[str, Any]:
    return {"ok": False, "reason": reason}


def parse_bool_env(name: str) -> tuple[bool | None, str | None]:
    raw = os.environ.get(name)
    if raw is None:
        return None, f"missing_env:{name}"
    normalized = raw.strip().lower()
    if normalized == "true":
        return True, None
    if normalized == "false":
        return False, None
    return None, f"invalid_bool_env:{name}"


def has_forbidden_key(value: Any, path: str = "$") -> str | None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).strip().lower().replace("-", "_")
            if any(part in normalized for part in FORBIDDEN_KEY_PARTS):
                return f"forbidden_secret_field:{path}.{key}"
            nested = has_forbidden_key(child, f"{path}.{key}")
            if nested:
                return nested
    elif isinstance(value, list):
        for index, child in enumerate(value):
            nested = has_forbidden_key(child, f"{path}[{index}]")
            if nested:
                return nested
    return None


def normalize_target(dex: Any, version: Any, error: str) -> tuple[str, str] | dict[str, Any]:
    if not isinstance(dex, str) or not dex.strip() or not isinstance(version, str) or not version.strip():
        return fail(error)
    normalized_version = version.strip().lower()
    if any(marker in normalized_version for marker in PLACEHOLDER_VERSION_MARKERS):
        return fail("placeholder_version_not_allowed")
    return dex.strip().lower(), normalized_version


def strict_nonnegative_int(value: Any, reason: str) -> int | dict[str, Any]:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return fail(reason)
    return value


def validate_runtime_env() -> dict[str, Any]:
    execution_mode = os.environ.get("EXECUTION_MODE")
    if execution_mode != "SHADOW":
        return fail("execution_mode_must_be_shadow")

    live_enabled, error = parse_bool_env("LIVE_ENABLED")
    if error:
        return fail(error)
    if live_enabled is not False:
        return fail("live_must_remain_disabled_during_preflight")

    fixture_gate, error = parse_bool_env("FIXTURE_GATE_PASSED")
    if error:
        return fail(error)
    if fixture_gate is not True:
        return fail("fixture_gate_not_approved")

    operator_approved, error = parse_bool_env("OPERATOR_APPROVED")
    if error:
        return fail(error)
    if operator_approved is not True:
        return fail("operator_not_approved")

    return {"ok": True}


def validate_manifest(manifest: Any) -> dict[str, Any]:
    if not isinstance(manifest, dict):
        return fail("manifest_must_be_object")

    secret_field = has_forbidden_key(manifest)
    if secret_field:
        return fail(secret_field)

    if manifest.get("schema_version") != SCHEMA_VERSION:
        return fail("unsupported_schema_version")

    if manifest.get("fixture_class") != "VERIFIED_ONCHAIN":
        return fail("fixture_class_must_be_verified_onchain")

    required_targets = manifest.get("required_targets")
    coverage = manifest.get("coverage")
    checks = manifest.get("checks")

    if not isinstance(required_targets, list) or not required_targets:
        return fail("required_targets_missing")
    if not isinstance(coverage, list) or not coverage:
        return fail("coverage_missing")
    if not isinstance(checks, dict):
        return fail("checks_missing")

    normalized_required: set[tuple[str, str]] = set()
    for target in required_targets:
        if not isinstance(target, dict):
            return fail("invalid_required_target")
        normalized = normalize_target(target.get("dex"), target.get("version"), "invalid_required_target")
        if isinstance(normalized, dict):
            return normalized
        if normalized in normalized_required:
            return fail("duplicate_required_target")
        normalized_required.add(normalized)

    required_families = {dex for dex, _ in normalized_required}
    for family in sorted(REQUIRED_DEX_FAMILIES):
        if family not in required_families:
            return fail(f"missing_required_dex_family:{family}")

    seen: set[tuple[str, str]] = set()
    for row in coverage:
        if not isinstance(row, dict):
            return fail("invalid_coverage_row")
        normalized = normalize_target(row.get("dex"), row.get("version"), "invalid_coverage_target")
        if isinstance(normalized, dict):
            return normalized
        if normalized in seen:
            return fail("duplicate_coverage_target")
        seen.add(normalized)
        if normalized not in normalized_required:
            return fail("coverage_contains_unrequired_target")

        if row.get("source") != "VERIFIED_ONCHAIN":
            return fail("coverage_source_not_verified_onchain")

        positive = strict_nonnegative_int(row.get("positive_verified"), "invalid_positive_fixture_count")
        if isinstance(positive, dict):
            return positive
        if positive < MIN_POSITIVE_FIXTURES:
            return fail("insufficient_positive_fixtures")

        negative = strict_nonnegative_int(row.get("negative_verified"), "invalid_negative_fixture_count")
        if isinstance(negative, dict):
            return negative
        if negative < MIN_NEGATIVE_FIXTURES:
            return fail("insufficient_negative_fixtures")

        false_positives = strict_nonnegative_int(
            row.get("negative_false_positives"), "invalid_negative_false_positive_count"
        )
        if isinstance(false_positives, dict):
            return false_positives
        if false_positives != 0:
            return fail("negative_false_positives_nonzero")

        pass_rate = row.get("regression_pass_rate")
        if isinstance(pass_rate, bool) or not isinstance(pass_rate, (int, float)):
            return fail("invalid_regression_pass_rate")
        if float(pass_rate) != 1.0:
            return fail("regression_not_100_percent")

        if row.get("exact_token_amount_reconciliation") is not True:
            return fail("reconciliation_not_exact")

        evidence_sha256 = row.get("evidence_sha256")
        if not isinstance(evidence_sha256, str) or not HEX64.fullmatch(evidence_sha256.lower()):
            return fail("invalid_evidence_sha256")

    if seen != normalized_required:
        return fail("required_target_coverage_incomplete")

    required_checks = (
        "replay_idempotency",
        "price_freshness",
        "execution_engine_v3_health",
        "signer_isolation",
    )
    for name in required_checks:
        if checks.get(name) is not True:
            return fail(f"check_failed:{name}")

    return {"ok": True, "targets": len(seen)}


def load_manifest(path: Path) -> tuple[Any | None, str | None]:
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return None, "manifest_unreadable"
    try:
        return json.loads(raw), None
    except json.JSONDecodeError:
        return None, "manifest_invalid_json"


def main() -> int:
    parser = argparse.ArgumentParser(description="AETHER read-only LIVE preflight")
    parser.add_argument(
        "--manifest",
        default=os.environ.get("AETHER_LIVE_PREFLIGHT_MANIFEST", ""),
        help="Path to a non-secret verified fixture evidence manifest",
    )
    args = parser.parse_args()

    if not args.manifest:
        result = fail("manifest_path_missing")
    else:
        manifest, error = load_manifest(Path(args.manifest))
        if error:
            result = fail(error)
        else:
            runtime = validate_runtime_env()
            result = runtime if not runtime["ok"] else validate_manifest(manifest)

    output = {
        "preflight": "AETHER_LIVE_V1",
        "eligible_for_operator_activation": bool(result.get("ok")),
        "live_enabled_by_this_script": False,
        **result,
    }
    print(json.dumps(output, sort_keys=True, separators=(",", ":")))
    return 0 if result.get("ok") else 2


if __name__ == "__main__":
    raise SystemExit(main())
