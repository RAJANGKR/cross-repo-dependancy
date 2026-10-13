"""DriftLock CI check: fail a pull request that introduces risky dependency drift.

    python backend/scripts/driftlock_ci.py \
        --head https://github.com/acme/service-a/tree/my-branch \
        --base https://github.com/acme/service-a/tree/main \
        --against https://github.com/acme/service-b \
        --against https://github.com/acme/service-c

It scans the pull request's branch and its base branch against the other
repositories, and fails only for drift the pull request adds or makes worse.

Exit codes: 0 the check passed, 1 the check failed, 2 the scan could not run
(for example a rate limit), which is reported as an error and never as a pass.

Set GITHUB_TOKEN in the environment to raise the GitHub API rate limit.
"""
import argparse
import asyncio
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.security import InvalidTarget  # noqa: E402
from app.services import ci_gate  # noqa: E402


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fail a pull request that introduces risky dependency drift.")
    parser.add_argument("--head", required=True, help="Repository URL of the change under test, usually with /tree/{branch}")
    parser.add_argument("--base", help="Repository URL of the base branch. Without it, every blocking drift counts as introduced.")
    parser.add_argument("--against", action="append", default=[], metavar="URL", help="Another repository to compare with. Repeat for each one.")
    parser.add_argument("--fail-on", choices=sorted(ci_gate.FAIL_ON), default="confirmed", help="What blocks the pull request (default: confirmed)")
    parser.add_argument("--fail-on-existing", action="store_true", help="Also fail for blocking drift that was already on the base branch")
    parser.add_argument("--no-code-scan", action="store_true", help="Skip the source-code usage scan")
    parser.add_argument("--summary-file", default=os.environ.get("GITHUB_STEP_SUMMARY"), help="Where to append the Markdown summary")
    return parser.parse_args(argv)


async def run(args: argparse.Namespace, http=None) -> int:
    others = [url.strip() for url in args.against if url.strip()]
    if not others:
        print("error: give at least one --against repository to compare with", file=sys.stderr)
        return 2

    async def scan(url: str):
        return await ci_gate.scan([url, *others], scan_code=not args.no_code_scan, http=http)

    try:
        head = await scan(args.head)
        base = await scan(args.base) if args.base else None
    except InvalidTarget as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    if head.status != "COMPLETED" or head.result is None:
        message = (head.error or {}).get("message", "the scan did not complete")
        print(f"error: the pull request branch could not be scanned: {message}", file=sys.stderr)
        return 2
    # A base that cannot be scanned is treated as "nothing known about before",
    # which is the strict reading: every blocking drift then counts as introduced.
    base_result = base.result if base and base.status == "COMPLETED" else None
    if args.base and base_result is None:
        print("warning: the base branch could not be scanned, so every blocking drift is reported as introduced", file=sys.stderr)

    verdict = ci_gate.compare(base_result, head.result, args.fail_on, args.fail_on_existing)
    summary = ci_gate.render_markdown(verdict, head.result)
    print(summary)
    if args.summary_file:
        with open(args.summary_file, "a", encoding="utf-8") as handle:
            handle.write(summary + "\n")
    return 1 if verdict.failed else 0


def main() -> int:
    return asyncio.run(run(parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
