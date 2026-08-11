# agente-qa

CLI de automatización de QA: describe en lenguaje natural qué hay que probar, y **Agente_QA** genera un plan de pruebas en Gherkin, lo convierte en tests Playwright (Python, pytest-bdd, Page Object Model), los ejecuta y genera reportes — todo desde la terminal, con tu propia API key (Anthropic, OpenAI o Google).

## Instalación

```
npm install -g agente-qa
agente-qa init
agente-qa chat
```

Requiere Node.js >= 22. A partir de "Generar tests Playwright" también necesita Python 3 + `ruff` en el `PATH`; a partir de "Ejecutar tests", además `pytest`, `pytest-bdd`, `pytest-playwright` y `pytest-html`. Detalle completo de requisitos y arquitectura: [github.com/Nicolascarames/Agente_QA](https://github.com/Nicolascarames/Agente_QA).

## Licencia

MIT — ver [LICENSE](./LICENSE).
