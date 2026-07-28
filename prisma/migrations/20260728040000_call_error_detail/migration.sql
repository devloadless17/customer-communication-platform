-- WHY a failed call failed, from the terminate webhook's errors[] — the only
-- place Meta reports it (troubleshooting doc codes 138019-138023, e.g.
-- "Media receive timeout"). Previously parse-then-dropped for calls (the
-- message path already persists its equivalents), so a failed call could only
-- ever render a generic "couldn't connect".
ALTER TABLE "Call" ADD COLUMN "errorCode" INTEGER;
ALTER TABLE "Call" ADD COLUMN "errorTitle" TEXT;
