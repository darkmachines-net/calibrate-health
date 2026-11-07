-- Provider state is mutable; the existing immutable identity trigger protects only identity columns.
ALTER TABLE "FirebaseIdentity" ADD COLUMN "security_stamp" TEXT;
ALTER TABLE "FirebaseIdentity" ADD COLUMN "deletion_pending_at" TIMESTAMP(3);
