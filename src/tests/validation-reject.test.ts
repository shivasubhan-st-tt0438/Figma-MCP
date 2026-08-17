import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/telemetry/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/telemetry/index.js")>();
  return {
    ...actual,
    captureValidationReject: vi.fn(),
    captureGetFigmaDataCall: vi.fn(),
    captureDownloadImagesCall: vi.fn(),
  };
});

import { createServer } from "~/mcp/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as telemetry from "~/telemetry/index.js";

/**
 * These tests cover the McpServer.validateToolInput monkey patch in
 * src/mcp/index.ts. They use a real Client/Server pair over InMemoryTransport
 * so the SDK validation path runs end-to-end — anything less wouldn't catch
 * SDK upgrades that change the validation signature.
 */
describe("validation reject capture (monkey patch)", () => {
  let client: Client;
  let server: McpServer;

  beforeEach(async () => {
    vi.mocked(telemetry.captureValidationReject).mockClear();

    server = createServer(
      { figmaApiKey: "test-key", figmaOAuthToken: "", useOAuth: false },
      { transport: "stdio" },
    );
    client = new Client({ name: "validation-test-client", version: "1.0.0" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientT), server.connect(serverT)]);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("captures structured field/rule when get_figma_data fileKey fails regex", async () => {
    // McpServer catches the validation McpError and turns it into a tool
    // result with isError=true (rather than rejecting the JSON-RPC request).
    // Our monkey patch fires before that conversion.
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: { fileKey: "invalid-key!" },
        },
      },
      CallToolResultSchema,
    );
    expect(result.isError).toBe(true);

    const captureSpy = vi.mocked(telemetry.captureValidationReject);
    expect(captureSpy).toHaveBeenCalledOnce();
    const [input] = captureSpy.mock.calls[0];
    expect(input.tool).toBe("get_figma_data");
    expect(input.field).toBe("fileKey");
    // Zod regex failures emit invalid_string in v3 and invalid_format in v4 —
    // accept either so the test doesn't break across SDK upgrades.
    expect(input.rule).toMatch(/invalid_string|invalid_format/);
  });

  it("normalizes array indexes to [] in nested validation_field", async () => {
    // get_figma_data.targets[1].fileKey fails the fileKey regex.
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "get_figma_data",
          arguments: {
            targets: [{ fileKey: "abc123" }, { fileKey: "BAD!!!" }],
          },
        },
      },
      CallToolResultSchema,
    );
    expect(result.isError).toBe(true);

    const captureSpy = vi.mocked(telemetry.captureValidationReject);
    expect(captureSpy).toHaveBeenCalledOnce();
    const [input] = captureSpy.mock.calls[0];
    expect(input.tool).toBe("get_figma_data");
    // The literal index 1 should be collapsed so `targets.1.fileKey` doesn't
    // appear with high cardinality in PostHog.
    expect(input.field).toBe("targets[].fileKey");
  });

  it("does not capture validation rejects on successful tool calls", async () => {
    // We don't actually want this to run the full pipeline — we only need to
    // confirm the monkey patch doesn't fire on the success path. Use a
    // syntactically valid fileKey; the call will fail later (no real API), but
    // SDK validation will pass and captureValidationReject must not be called.
    await client
      .request(
        {
          method: "tools/call",
          params: {
            name: "get_figma_data",
            arguments: { fileKey: "abc123" },
          },
        },
        CallToolResultSchema,
      )
      .catch(() => {
        // Network failure or tool-level error is fine — we don't care about the
        // outcome, only that the validation hook stayed quiet.
      });

    expect(vi.mocked(telemetry.captureValidationReject)).not.toHaveBeenCalled();
  });
});
