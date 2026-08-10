import { describe, it, expect } from "vitest";
import { slugify } from "./slugify.js";

describe("slugify", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Login de Usuario")).toBe("login-de-usuario");
  });

  it("strips accents and non-alphanumeric characters", () => {
    expect(slugify("¿Puedo iniciar sesión?!")).toBe("puedo-iniciar-sesion");
  });

  it("collapses repeated separators and trims leading/trailing hyphens", () => {
    expect(slugify("  --Hola   Mundo--  ")).toBe("hola-mundo");
  });
});
