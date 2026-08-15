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

  it("accepts env-read that appears BEFORE an unrelated comparison in a different method", () => {
    // The anti-pattern is reading env AS A CONSEQUENCE of the comparison,
    // so env-read comes AFTER (or on the same line). If env-read comes BEFORE,
    // it's a separate concern — e.g., initialization in __init__, comparison in select_role().
    const result = checkCredentialSubstitution([
      {
        path: "pages/login_page.py",
        content:
          'self.base_url = os.environ["AGENTE_QA_APP_URL"]\n' +
          "pass\n" +
          "pass\n" +
          'if role == "admin":\n' +
          '    self.page.get_by_role("option", name="Admin").click()\n',
      },
    ]);
    expect(result.ok).toBe(true);
  });
});
