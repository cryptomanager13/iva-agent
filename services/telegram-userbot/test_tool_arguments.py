import asyncio
import json
import unittest

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

from serve import NormalizeToolArgumentsMiddleware, _normalize_tool_arguments


class NormalizeToolArgumentsTest(unittest.TestCase):
    """Cover JSON normalization and the ASGI request-body boundary."""

    def test_omits_null_optional_arguments_from_a_tool_call(self):
        """Keep populated tool arguments and omit nullable optional arguments."""
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "list_messages",
                "arguments": {
                    "chat_id": "@example",
                    "limit": 100,
                    "search_query": None,
                    "from_date": None,
                    "to_date": None,
                    "account": None,
                },
            },
        }

        normalized = json.loads(_normalize_tool_arguments(json.dumps(payload).encode()))

        self.assertEqual(
            normalized["params"]["arguments"],
            {"chat_id": "@example", "limit": 100},
        )

    def test_preserves_non_tool_requests_and_invalid_json(self):
        """Preserve requests that the middleware does not own."""
        initialize = b'{"method":"initialize","params":{"clientInfo":null}}'

        self.assertEqual(_normalize_tool_arguments(initialize), initialize)
        self.assertEqual(_normalize_tool_arguments(b"not json"), b"not json")

    def test_asgi_middleware_reaches_a_real_fastmcp_tool(self):
        """Deliver a null optional argument to FastMCP as an omitted argument."""
        async def exercise():
            """Call the production FastMCP HTTP app through the middleware stack."""
            received = []
            mcp = FastMCP("test")
            mcp.settings.transport_security = TransportSecuritySettings(
                enable_dns_rebinding_protection=False
            )

            @mcp.tool()
            def optional_argument(value: str = None):
                """Record the value that FastMCP passes to the tool handler."""
                received.append(value)
                return "called"

            app = mcp.streamable_http_app()
            app.add_middleware(NormalizeToolArgumentsMiddleware)
            headers = {
                "accept": "application/json, text/event-stream",
                "content-type": "application/json",
            }
            initialize = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "test", "version": "1"},
                },
            }
            call = {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "optional_argument", "arguments": {"value": None}},
            }
            async with app.router.lifespan_context(app):
                transport = httpx.ASGITransport(app=app)
                async with httpx.AsyncClient(
                    transport=transport, base_url="http://test"
                ) as client:
                    initialized = await client.post(
                        "/mcp", headers=headers, content=json.dumps(initialize)
                    )
                    self.assertEqual(initialized.status_code, 200)
                    headers["mcp-session-id"] = initialized.headers["mcp-session-id"]
                    ready = await client.post(
                        "/mcp",
                        headers=headers,
                        content=json.dumps(
                            {"jsonrpc": "2.0", "method": "notifications/initialized"}
                        ),
                    )
                    self.assertEqual(ready.status_code, 202)
                    response = await client.post(
                        "/mcp", headers=headers, content=json.dumps(call)
                    )
            return response, received

        response, received = asyncio.run(exercise())

        self.assertEqual(response.status_code, 200)
        self.assertIn('"isError":false', response.text)
        self.assertEqual(received, [None])


if __name__ == "__main__":
    unittest.main()
