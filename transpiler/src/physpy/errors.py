class TranspileError(Exception):
    """Error in PhysPy-specific syntax, with a 1-based line and column."""

    def __init__(self, message: str, line: int, col: int):
        super().__init__(message)
        self.message = message
        self.line = line
        self.col = col

    def format(self, filename: str) -> str:
        return f"{filename}:{self.line}:{self.col}: error: {self.message}"


def position(src: str, index: int) -> tuple[int, int]:
    """Convert a 0-based string index into a 1-based (line, col) pair."""
    line = src.count("\n", 0, index) + 1
    col = index - (src.rfind("\n", 0, index) + 1) + 1
    return line, col
