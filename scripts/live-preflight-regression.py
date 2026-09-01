#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PREFLIGHT = ROOT / "preflight_live.py"

BASE_ENV = {
    "EXECUTION_MODE": "SHADOW",
    "LIVE_ENABLED": "false",
    "FIXTURE_GATE_PASSED": "true",
    "OPERATOR_APPROVED": "true",
}


def valid_manifest() -> dict:
    targets = [
        ("jupiter", "router-v6"),
        ("raydium", "amm-v4"),
        ("orca", "whirlpool-v2"),
    ]
    hashes = {
        "jupiter": "ab" * 32,
        "raydium": "cd" * 32,
        "orca": "ef" * 32,
    }
    return {
        "schema_version": 1,
        "fixture_class": "VERIFIED_ONCHAIN",
        "required_targets": [{"dex": dex, "version": version} for dex, version in targets],
        "coverage": [
            {
                "dex": dex,
                "version": version,
                "source": "VERIFIED_ONCHAIN",
                "positive_verified": 30,
                "negative_verified": 10,
                "negative_false_positives": 0,
                "regression_pass_rate": 1.0,
                "exact_token_amount_reconciliation": True,
                "evidence_sha256": hashes[dex],
            }
            for dex, version in targets
        ],
        "checks": {
            "replay_idempotency": True,
            "price_freshness": True,
            "execution_engine_v3_health": True,
            "signer_isolation": True,
        },
    }


def run_case(manifest: dict | None, *, env_overrides: dict[str, str] | None = None):
    env = os.environ.copy()
    env.update(BASE_ENV)
    if env_overrides:
        env.update(env_overrides)

    if manifest is None:
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT)],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )
    else:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            proc = subprocess.run(
                [sys.executable, str(PREFLIGHT), "--manifest", str(path)],
                cwd=ROOT,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

    payload = json.loads(proc.stdout)
    assert payload["live_enabled_by_this_script"] is False
    return proc.returncode, payload


def expect_fail(manifest, reason, *, env_overrides=None):
    code, payload = run_case(manifest, env_overrides=env_overrides)
    assert code == 2, (reason, code, payload, proc.stderr if "proc" in locals() else "")
    assert payload["eligible_for_operator_activation"] is False
    assert payload["reason"] == reason, payload


def main():
    expect_fail(None, "manifest_path_missing")

    code, payload = run_case(valid_manifest())
    assert code == 0, payload
    assert payload["eligible_for_operator_activation"] is True
    assert payload["targets"] == 3

    weak = valid_manifest()
    weak["coverage"][0]["positive_verified"] = 29
    expect_fail(weak, "insufficient_positive_fixtures")

    synthetic = valid_manifest()
    synthetic["fixture_class"] = "SYNTHETIC_TEST"
    expect_fail(synthetic, "fixture_class_must_be_verified_onchain")

    incomplete = valid_manifest()
    incomplete["coverage"].pop()
    expect_fail(incomplete, "required_target_coverage_incomplete")

    secret = valid_manifest()
    secret["api_token"] = "must-not-be-here"
    expect_fail(secret, "forbidden_secret_field:$.api_token")

    expect_fail(
        valid_manifest(),
        "live_must_remain_disabled_during_preflight",
        env_overrides={"LIVE_ENABLED": "true"},
    )
    expect_fail(
        valid_manifest(),
        "fixture_gate_not_approved",
        env_overrides={"FIXTURE_GATE_PASSED": "false"},
    )
    expect_fail(
        valid_manifest(),
        "operator_not_approved",
        env_overrides={"OPERATOR_APPROVED": "false"},
    )
    expect_fail(
        valid_manifest(),
        "execution_mode_must_be_shadow",
        env_overrides={"EXECUTION_MODE": "LIVE"},
    )

    stale = valid_manifest()
    stale["checks"]["price_freshness"] = False
    expect_fail(stale, "check_failed:price_freshness")

    print("live preflight fail-closed regression: PASS")


if __name__ == "__main__":
    main()
