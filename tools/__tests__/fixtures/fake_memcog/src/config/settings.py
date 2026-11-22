"""Stand-in for MemCog's `config/settings.py`: the store root, and nothing else.

The real module also derives a directory name from a QA filename, which the driver never calls. Keeping the fixture
minimal is the point: if the driver needs a function this file does not have, the driver is reaching further into the
package than `run_write.py` does and the failure should appear here rather than on a runner.
"""

from pathlib import Path

_store_root: Path = Path("./MemCog_store")


def get_store_root() -> Path:
    return _store_root


def set_store_root(path) -> None:
    global _store_root
    _store_root = Path(path)
