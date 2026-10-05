UPDATE history_records
SET record = record - 'shell'
WHERE record ? 'shell';
