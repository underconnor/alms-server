CREATE TABLE personal_learning_completions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id text NOT NULL CHECK (course_id ~ '^[A-Za-z0-9:_-]{1,200}$'),
  activity_id text NOT NULL CHECK (activity_id ~ '^[A-Za-z0-9:_-]{1,200}$'),
  completed boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,course_id,activity_id)
);
