# PostgreSQL backup and restore image with age encryption. The default command runs scheduled backups.
FROM postgres:16-alpine

RUN apk add --no-cache age tzdata

COPY backup-postgres.sh restore-postgres.sh /usr/local/bin/
RUN chmod 0555 /usr/local/bin/backup-postgres.sh /usr/local/bin/restore-postgres.sh

ENTRYPOINT []
CMD ["/usr/local/bin/backup-postgres.sh"]
