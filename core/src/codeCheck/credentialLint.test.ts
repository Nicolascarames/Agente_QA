import { describe, it, expect } from "vitest";
import { checkCredentialSubstitution } from "./credentialLint.js";

describe("checkCredentialSubstitution", () => {
  it("rejects picking a credential by comparing against a literal", () => {
    const result = checkCredentialSubstitution([
      {
        path: "pages/login_page.py",
        content:
          'actual_email = os.environ.get("AGENTE_QA_TEST_USERNAME", email) if email == "user@example.com" else email\n',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pages/login_page.py:1");
  });

  it("rejects the multi-line if-body form (comparison and env-read on separate, nearby lines)", () => {
    const result = checkCredentialSubstitution([
      {
        path: "pages/login_page.py",
        content: 'if email == "user@example.com":\n    email = os.environ["AGENTE_QA_TEST_USERNAME"]\n',
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pages/login_page.py:1");
  });

  it("accepts reading the credential unconditionally", () => {
    const result = checkCredentialSubstitution([
      { path: "pages/login_page.py", content: 'email = os.environ["AGENTE_QA_TEST_USERNAME"]\n' },
    ]);
    expect(result.ok).toBe(true);
  });

  it("ignores comments", () => {
    const result = checkCredentialSubstitution([
      { path: "pages/login_page.py", content: '# no hagas os.environ[...] if x == "y"\n' },
    ]);
    expect(result.ok).toBe(true);
  });
});
