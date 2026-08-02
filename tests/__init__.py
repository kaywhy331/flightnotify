"""Test package.

This file is required: several test modules import shared transports with
``from tests.conftest import ...``. Without it, ``tests`` is only importable
when the current directory happens to be on ``sys.path`` -- true for
``python -m pytest`` (which prepends the cwd) but not for a bare ``pytest``,
which is what CI runs.
"""
