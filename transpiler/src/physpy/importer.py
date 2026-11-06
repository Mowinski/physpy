"""Import hook: lets `import foo` load and transpile `foo.ppy`."""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import importlib.util
import os
import sys

from .pipeline import compile_source

EXTENSION = ".ppy"


class PpyLoader(importlib.machinery.SourceFileLoader):
    def get_code(self, fullname):  # no bytecode cache - always transpile
        return compile_source(self.get_source(fullname), self.path)


class PpyFinder(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path, target=None):
        name = fullname.rpartition(".")[2]
        for entry in path or sys.path:
            candidate = os.path.join(entry or ".", name + EXTENSION)
            if os.path.isfile(candidate):
                loader = PpyLoader(fullname, candidate)
                return importlib.util.spec_from_file_location(fullname, candidate, loader=loader)
        return None


def install() -> None:
    if not any(isinstance(f, PpyFinder) for f in sys.meta_path):
        sys.meta_path.append(PpyFinder())
