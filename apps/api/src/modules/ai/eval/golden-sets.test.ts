/**
 * Integridade dos golden sets do escriba (docs/05-ia-llm/golden-sets/).
 * Garante no CI que:
 * - todo caso é marcado como sintético e não carrega padrão de dado pessoal real;
 * - a nota de referência passa nas próprias checagens (âncoras, obrigatórios, armadilhas,
 *   alerta): um golden set incoerente reprovaria qualquer modelo injustamente;
 * - casos de recusa (CFM 2.454/2026) são bloqueados pela política de roteamento.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeLlmProvider } from '../providers/fake-llm.provider';
import { routeRequest } from '../routing-policy';
import type { AiNiche, PatientAiConsent } from '../llm-provider';
import {
  omittedItems,
  triggeredTraps,
  unanchoredItems,
  type RequiredItem,
  type ScribeNote,
  type TranscriptTurn,
  type Trap,
} from './escriba-checks';

interface GoldenCase {
  id: string;
  cenario: string;
  tags: string[];
  consentimento_ia: PatientAiConsent;
  resultado_esperado: 'rascunho' | 'bloqueado';
  transcricao: TranscriptTurn[];
  nota_referencia: ScribeNote | null;
  obrigatorios: RequiredItem[];
  armadilhas: Trap[];
  alerta_obrigatorio: boolean;
}

interface GoldenSet {
  versao: string;
  nicho: AiNiche;
  sintetico: boolean;
  casos: GoldenCase[];
}

const DIR = join(__dirname, '../../../../../../docs/05-ia-llm/golden-sets');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
const sets = files.map((f) => ({ file: f, set: JSON.parse(readFileSync(join(DIR, f), 'utf8')) as GoldenSet }));
const cases = sets.flatMap(({ set }) => set.casos.map((c) => ({ nicho: set.nicho, c })));

/** Padrões de dado pessoal que nunca podem aparecer num golden set. */
const PII_PATTERNS: Record<string, RegExp> = {
  cpf: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/,
  cns: /\b\d{15}\b/,
  telefone: /\(?\b\d{2}\)?\s?9?\d{4}-\d{4}\b/,
  email: /[\w.+-]+@[\w-]+\.[\w.]+/,
  data: /\b\d{2}\/\d{2}\/\d{4}\b/,
};

describe('golden sets do escriba', () => {
  it('existem os dois nichos de entrada', () => {
    expect(sets.map((s) => s.set.nicho).sort()).toEqual(['fisio_to', 'psicologia']);
  });

  it.each(sets)('$file é marcado como sintético', ({ set }) => {
    expect(set.sintetico).toBe(true);
  });

  it('ids são únicos', () => {
    const ids = cases.map(({ c }) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(Object.entries(PII_PATTERNS))('nenhum caso contém padrão de %s', (_nome, re) => {
    for (const { file, set } of sets) {
      expect(re.test(JSON.stringify(set)), file).toBe(false);
    }
  });

  it('cada nicho cobre os casos difíceis obrigatórios do protocolo', () => {
    for (const { set } of sets) {
      const tags = new Set(set.casos.flatMap((c) => c.tags));
      for (const tag of ['negacao', 'terceiro_citado', 'injecao_falada', 'recusa_cfm_2454']) {
        expect(tags.has(tag), `${set.nicho}: falta ${tag}`).toBe(true);
      }
      expect(set.casos.some((c) => c.alerta_obrigatorio), `${set.nicho}: falta caso de risco`).toBe(true);
    }
  });
});

describe.each(cases.filter(({ c }) => c.resultado_esperado === 'rascunho'))('referência $c.id', ({ c }) => {
  const note = c.nota_referencia as ScribeNote;

  it('tem nota de referência', () => {
    expect(note).not.toBeNull();
  });

  it('toda afirmação tem âncora literal na transcrição', () => {
    expect(unanchoredItems(note, c.transcricao).map((i) => i.texto)).toEqual([]);
  });

  it('não dispara nenhuma armadilha', () => {
    expect(triggeredTraps(note, c.armadilhas).map((t) => t.id)).toEqual([]);
  });

  it('não omite itens obrigatórios', () => {
    expect(omittedItems(note, c.obrigatorios).map((r) => r.id)).toEqual([]);
  });

  it('alerta presente se e somente se o caso exige', () => {
    expect((note.alertas ?? []).length > 0).toBe(c.alerta_obrigatorio);
  });
});

describe.each(cases.filter(({ c }) => c.resultado_esperado === 'bloqueado'))('recusa $c.id', ({ nicho, c }) => {
  it('a política de roteamento bloqueia o escriba', () => {
    const r = routeRequest(
      {
        task: 'escriba',
        niche: nicho,
        sensitivity: 'sensivel',
        tenantPolicy: { aiEnabled: true, allowsInternationalTransfer: false },
        patientConsent: c.consentimento_ia,
      },
      [new FakeLlmProvider()],
    );
    expect(r).toEqual({ allowed: false, reason: 'paciente_recusou_ia' });
    expect(c.nota_referencia).toBeNull();
  });
});

describe('as checagens pegam erros (mutações da referência)', () => {
  const ft1 = cases.find(({ c }) => c.id === 'FT-001')!.c;
  const ref = ft1.nota_referencia!;

  it('afirmação inventada sem âncora é detectada', () => {
    const mutada: ScribeNote = {
      ...ref,
      secoes: [...ref.secoes, { titulo: 'Extra', itens: [{ texto: 'Usa dipirona.', ancora: 'tomo dipirona' }] }],
    };
    expect(unanchoredItems(mutada, ft1.transcricao)).toHaveLength(1);
  });

  it('negação invertida dispara a armadilha', () => {
    const mutada: ScribeNote = {
      secoes: [{ titulo: 'S', itens: [{ texto: 'Dor com irradiação para MIE.', ancora: 'fica só na lombar' }] }],
    };
    expect(triggeredTraps(mutada, ft1.armadilhas).map((t) => t.id)).toContain('irradiacao_inventada');
  });

  it('nota vazia omite tudo', () => {
    expect(omittedItems({ secoes: [] }, ft1.obrigatorios)).toHaveLength(ft1.obrigatorios.length);
  });
});
