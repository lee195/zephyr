-- Tables as opencode 1.18.33 creates them (sqlite3 .schema of a fresh opencode.db); rows are synthetic.
CREATE TABLE `session` (
`id` text PRIMARY KEY,
`project_id` text NOT NULL,
`workspace_id` text,
`parent_id` text,
`slug` text NOT NULL,
`directory` text NOT NULL,
`path` text,
`title` text NOT NULL,
`version` text NOT NULL,
`share_url` text,
`summary_additions` integer,
`summary_deletions` integer,
`summary_files` integer,
`summary_diffs` text,
`metadata` text,
`cost` real DEFAULT 0 NOT NULL,
`tokens_input` integer DEFAULT 0 NOT NULL,
`tokens_output` integer DEFAULT 0 NOT NULL,
`tokens_reasoning` integer DEFAULT 0 NOT NULL,
`tokens_cache_read` integer DEFAULT 0 NOT NULL,
`tokens_cache_write` integer DEFAULT 0 NOT NULL,
`revert` text,
`permission` text,
`agent` text,
`model` text,
`time_created` integer NOT NULL,
`time_updated` integer NOT NULL,
`time_compacting` integer,
`time_archived` integer,
CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
CREATE INDEX `session_project_idx` ON `session` (`project_id`);
CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`);
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);
CREATE TABLE `message` (
`id` text PRIMARY KEY,
`session_id` text NOT NULL,
`time_created` integer NOT NULL,
`time_updated` integer NOT NULL,
`data` text NOT NULL,
CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);
CREATE TABLE `part` (
`id` text PRIMARY KEY,
`message_id` text NOT NULL,
`session_id` text NOT NULL,
`time_created` integer NOT NULL,
`time_updated` integer NOT NULL,
`data` text NOT NULL,
CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
        );
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);
CREATE INDEX `part_session_idx` ON `part` (`session_id`);

INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES
  ('ses_fixture0001A', 'global', 'fixture', '/tmp/zephyr-fixture', 'fixture', '1.18.33', 1792414000000, 1792414100000),
  ('ses_fixture0002B', 'global', 'other', '/tmp/zephyr-fixture', 'other', '1.18.33', 1792414000000, 1792414100000);

INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES
  ('msg_fixture0001', 'ses_fixture0001A', 1792414085530, 1792414085536, '{"role":"user","time":{"created":1792414085530},"agent":"build","model":{"providerID":"deepseek","modelID":"deepseek-v4-pro"}}'),
  ('msg_fixture0002', 'ses_fixture0001A', 1792414090000, 1792414090004, '{"role":"user","time":{"created":1792414090000},"agent":"build","model":{"providerID":"deepseek","modelID":"deepseek-v4-pro"}}'),
  ('msg_fixture0003', 'ses_fixture0001A', 1792414090100, 1792414095000, '{"parentID":"msg_fixture0002","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/tmp/zephyr-fixture","root":"/tmp/zephyr-fixture"},"cost":0,"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"modelID":"deepseek-v4-pro","providerID":"deepseek","time":{"created":1792414090100,"completed":1792414095000},"finish":"stop"}'),
  ('msg_fixture0004', 'ses_fixture0001A', 1792414099000, 1792414099006, '{"role":"user","time":{"created":1792414099000},"agent":"build","model":{"providerID":"deepseek","modelID":"deepseek-v4-pro"}}'),
  ('msg_fixture0005', 'ses_fixture0002B', 1792414099500, 1792414099506, '{"role":"user","time":{"created":1792414099500},"agent":"build","model":{"providerID":"deepseek","modelID":"deepseek-v4-pro"}}');

INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES
  ('prt_fixture0001', 'msg_fixture0001', 'ses_fixture0001A', 1792414085537, 1792414085537, '{"type":"text","text":"[zephyr] first note"}'),
  ('prt_fixture0002', 'msg_fixture0002', 'ses_fixture0001A', 1792414090001, 1792414090001, '{"type":"text","text":"hello model"}'),
  ('prt_fixture0003', 'msg_fixture0003', 'ses_fixture0001A', 1792414090200, 1792414090200, '{"type":"step-start"}'),
  ('prt_fixture0004', 'msg_fixture0003', 'ses_fixture0001A', 1792414090300, 1792414095000, '{"type":"text","text":"[zephyr] an assistant echo is not a note","time":{"start":1792414090300,"end":1792414095000}}'),
  ('prt_fixture0005', 'msg_fixture0004', 'ses_fixture0001A', 1792414099007, 1792414099007, '{"type":"text","text":"[zephyr] second note"}'),
  ('prt_fixture0006', 'msg_fixture0005', 'ses_fixture0002B', 1792414099507, 1792414099507, '{"type":"text","text":"[zephyr] a note in another session"}');
