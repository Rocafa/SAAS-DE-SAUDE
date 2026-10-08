type ValueOf<T> = T[keyof T];

export const AppointmentStatus = {
  Scheduled: 'scheduled',
  Confirmed: 'confirmed',
  CheckedIn: 'checked_in',
  InProgress: 'in_progress',
  Completed: 'completed',
  Cancelled: 'cancelled',
  NoShow: 'no_show',
} as const;
export type AppointmentStatus = ValueOf<typeof AppointmentStatus>;

export const AppointmentModality = {
  InPerson: 'in_person',
  Telehealth: 'telehealth',
} as const;
export type AppointmentModality = ValueOf<typeof AppointmentModality>;

export const RecordEntryStatus = {
  Draft: 'draft',
  Signed: 'signed',
  Superseded: 'superseded',
} as const;
export type RecordEntryStatus = ValueOf<typeof RecordEntryStatus>;

export const PaymentMethod = {
  Pix: 'pix',
  Boleto: 'boleto',
  CreditCard: 'credit_card',
  Cash: 'cash',
  Insurance: 'insurance',
} as const;
export type PaymentMethod = ValueOf<typeof PaymentMethod>;

/** Bases legais da LGPD (arts. 7º e 11) usadas no registro de tratamento/consentimento. */
export const LegalBasis = {
  Consent: 'consent',
  LegalObligation: 'legal_obligation',
  ContractExecution: 'contract_execution',
  HealthProtection: 'health_protection',
  RegularExerciseOfRights: 'regular_exercise_of_rights',
  LegitimateInterest: 'legitimate_interest',
} as const;
export type LegalBasis = ValueOf<typeof LegalBasis>;

/** Ações auditáveis. O log registra a ação, nunca o conteúdo clínico. */
export const AuditAction = {
  Read: 'read',
  Create: 'create',
  Update: 'update',
  Sign: 'sign',
  Export: 'export',
  Share: 'share',
  Login: 'login',
  LoginFailed: 'login_failed',
  PermissionChange: 'permission_change',
  ConsentChange: 'consent_change',
} as const;
export type AuditAction = ValueOf<typeof AuditAction>;
