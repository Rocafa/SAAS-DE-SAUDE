/** Tipos nominais ("branded") para impedir troca acidental de IDs entre entidades. */
type Brand<T, B extends string> = T & { readonly __brand: B };

export type TenantId = Brand<string, 'TenantId'>;
export type ClinicId = Brand<string, 'ClinicId'>;
export type UserId = Brand<string, 'UserId'>;
export type ProfessionalId = Brand<string, 'ProfessionalId'>;
export type PatientId = Brand<string, 'PatientId'>;
export type AppointmentId = Brand<string, 'AppointmentId'>;
export type MedicalRecordId = Brand<string, 'MedicalRecordId'>;
export type RecordEntryId = Brand<string, 'RecordEntryId'>;
export type PrescriptionId = Brand<string, 'PrescriptionId'>;
export type ChargeId = Brand<string, 'ChargeId'>;
