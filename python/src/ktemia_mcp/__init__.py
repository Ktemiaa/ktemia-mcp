"""Model Context Protocol server for the Ktemia travel search API."""

from .client import KtemiaClient, KtemiaError
from .server import create_server

__version__ = "0.1.3"
__all__ = ["KtemiaClient", "KtemiaError", "create_server", "__version__"]
