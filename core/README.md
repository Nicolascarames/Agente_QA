# @agente-qa/core

Motor compartido (sin interfaz de usuario) del pipeline de automatización de QA **Agente_QA**: 4 agentes especializados que convierten una descripción de pruebas en lenguaje natural en un plan Gherkin, tests Playwright (Python, pytest-bdd, Page Object Model), su ejecución, y reportes de resultados.

Este paquete no se usa solo — es el motor que consume la CLI [`agente-qa`](https://www.npmjs.com/package/agente-qa). Toda interacción con el usuario cruza callbacks inyectados; `core` no hace I/O de terminal directo.

Documentación completa, arquitectura y specs de diseño: [github.com/Nicolascarames/Agente_QA](https://github.com/Nicolascarames/Agente_QA).

## Licencia

MIT — ver [LICENSE](./LICENSE).
