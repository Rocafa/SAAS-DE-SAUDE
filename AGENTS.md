# Instruções para agentes de IA neste repositório

1. Leia `CONTEXTO.md`, `docs/00-governanca/hierarquia.md` e `docs/00-governanca/fluxograma.md` antes de qualquer tarefa.
2. Respeite a cadeia: executor (N3) → líder de frente (N2) → Maestro (N1) → sócios (N0).
3. Toda entrega que toque dado pessoal/de saúde passa pelo agente `guardiao-lgpd` (veto absoluto).
4. Branches: `<frente>/<microparte>` (ex.: `eng/agenda-api`). Commits: Conventional Commits em português.
5. Nunca coloque dado real de paciente, segredo ou certificado no git, em prompts ou em datasets.
6. Números de mercado sempre com fonte (URL + data). Separe FATO de ESTIMATIVA.
7. **Economia de tokens:** no máximo **3 subagentes** simultâneos por tarefa. Prefira fazer direto; delegue só o que é grande e independente, com escopo enxuto.
8. **Nada se perde:** commite após cada entrega. Perto do limite de uso (~90%), commite tudo e registre um relatório em `docs/relatorios/AAAA-MM-DD-<tema>.md`.
