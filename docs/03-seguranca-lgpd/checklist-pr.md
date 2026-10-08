# Checklist LGPD & Segurança para PR

> Copie para a descrição do PR. Qualquer **"Não"** em item marcado com 🔴 = **veto do Guardião** até corrigir ou ter exceção aprovada por escrito (Guardião + N1). "N/A" exige justificativa de uma linha.

## Dados e privacidade
| # | Pergunta | Sim/Não/N/A |
|---|---|---|
| 1 🔴 | O PR toca dado pessoal? Se sim, a finalidade e a base legal estão em `bases-legais-e-consentimento.md` (ou foi atualizado)? | |
| 2 🔴 | Coleta apenas o mínimo necessário (sem campos novos "por via das dúvidas")? | |
| 3 🔴 | Nenhum dado real de paciente em código, testes, seeds, fixtures, screenshots ou prompts (somente dados sintéticos)? | |
| 4 | Se depende de consentimento, o servidor verifica consentimento ativo antes de executar? | |
| 5 | Se cria novo fluxo de dado sensível, novo suboperador ou uso de IA: RIPD/ROPA atualizados? | |
| 6 | Respeita retenção (sem exclusão física de prontuário; sem guardar além do prazo definido)? | |

## Isolamento e acesso
| # | Pergunta | Sim/Não/N/A |
|---|---|---|
| 7 🔴 | Toda query nova filtra por `tenant_id` **e** a tabela tem RLS com `FORCE`? | |
| 8 🔴 | Há teste automatizado provando que o tenant A não acessa dados do tenant B? | |
| 9 🔴 | Endpoints novos têm autenticação e autorização (RBAC + vínculo de cuidado/ABAC) no servidor? | |
| 10 | Perfis não clínicos (recepção, financeiro) continuam sem acesso a conteúdo clínico? | |

## Criptografia, segredos e logs
| # | Pergunta | Sim/Não/N/A |
|---|---|---|
| 11 🔴 | Campos C4 (clínicos) novos usam criptografia em nível de campo com chave do tenant? | |
| 12 🔴 | Nenhum segredo, token ou certificado no diff (secret scan passou)? | |
| 13 🔴 | Nenhum dado pessoal sensível, prompt de IA ou payload de prontuário vai para logs, APM ou Sentry? | |
| 14 | Ações de leitura/escrita/exportação em dado C3/C4 geram evento de auditoria? | |

## Integrações e IA
| # | Pergunta | Sim/Não/N/A |
|---|---|---|
| 15 🔴 | Novo fornecedor/API externa: está na lista de suboperadores, com DPA e (se fora do Brasil) cláusulas-padrão da ANPD? | |
| 16 🔴 | Chamadas a LLM passam pelo gateway `ai` (pseudonimização, auditoria, sem retenção/treino no provedor)? | |
| 17 🔴 | Saída de IA entra como rascunho com revisão humana obrigatória e registro de uso de IA no prontuário? | |
| 18 | Mensagens de WhatsApp/SMS/e-mail sem informação clínica (template aprovado)? | |

## Segurança de aplicação
| # | Pergunta | Sim/Não/N/A |
|---|---|---|
| 19 🔴 | SAST, SCA e scan de imagem sem vulnerabilidade crítica/alta aberta? | |
| 20 | Entradas validadas no servidor; uploads com checagem de tipo/tamanho; saídas escapadas (XSS)? | |
| 21 | Mudança em auth, sessão, criptografia, prontuário, prescrição ou IA teve revisão de um segundo engenheiro com foco em segurança? | |
| 22 | Mudança de infraestrutura mantém dados em região brasileira e passou no scan de IaC? | |

**Resultado:** ☐ Aprovado ☐ Aprovado com ressalvas (listar) ☐ Vetado

Referências: [requisitos-tecnicos-seguranca.md](requisitos-tecnicos-seguranca.md) · [lgpd-e-ia.md](lgpd-e-ia.md) · [bases-legais-e-consentimento.md](bases-legais-e-consentimento.md)
