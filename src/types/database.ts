// =====================================================================
// Generated Supabase schema types (via Supabase type generation against
// the live project). Used to parameterize the Supabase clients so that
// .from().insert()/.update()/.rpc() are typed instead of `never`.
// Regenerate after schema changes.
// =====================================================================
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      agent_call_configs: {
        Row: {
          agent_id: string
          cadence_day_gaps: number[]
          call_window_end: string
          call_window_start: string
          created_at: string
          daily_run_at: string
          drip_seconds: number
          max_attempts_per_contact: number
          max_calls_per_day: number
          max_total_calls: number | null
          updated_at: string
        }
        Insert: {
          agent_id: string
          cadence_day_gaps?: number[]
          call_window_end?: string
          call_window_start?: string
          created_at?: string
          daily_run_at?: string
          drip_seconds?: number
          max_attempts_per_contact?: number
          max_calls_per_day?: number
          max_total_calls?: number | null
          updated_at?: string
        }
        Update: {
          agent_id?: string
          cadence_day_gaps?: number[]
          call_window_end?: string
          call_window_start?: string
          created_at?: string
          daily_run_at?: string
          drip_seconds?: number
          max_attempts_per_contact?: number
          max_calls_per_day?: number
          max_total_calls?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_call_configs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: true
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_memory: {
        Row: {
          agent_id: string
          call_count: number
          contact_id: string
          facts: Json
          id: string
          last_call_id: string | null
          objective_state: Json
          summary: string
          updated_at: string
          workspace_id: string
        }
        Insert: {
          agent_id: string
          call_count?: number
          contact_id: string
          facts?: Json
          id?: string
          last_call_id?: string | null
          objective_state?: Json
          summary?: string
          updated_at?: string
          workspace_id: string
        }
        Update: {
          agent_id?: string
          call_count?: number
          contact_id?: string
          facts?: Json
          id?: string
          last_call_id?: string | null
          objective_state?: Json
          summary?: string
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_memory_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_last_call_id_fkey"
            columns: ["last_call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_memory_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_task_configs: {
        Row: {
          agent_id: string
          assignee_crm_id: string | null
          assignee_label: string | null
          created_at: string
          due_offset_minutes: number
          enabled: boolean
          name_template: string
          only_outcomes: Database["public"]["Enums"]["call_outcome"][] | null
          task_type: string
          updated_at: string
        }
        Insert: {
          agent_id: string
          assignee_crm_id?: string | null
          assignee_label?: string | null
          created_at?: string
          due_offset_minutes?: number
          enabled?: boolean
          name_template?: string
          only_outcomes?: Database["public"]["Enums"]["call_outcome"][] | null
          task_type?: string
          updated_at?: string
        }
        Update: {
          agent_id?: string
          assignee_crm_id?: string | null
          assignee_label?: string | null
          created_at?: string
          due_offset_minutes?: number
          enabled?: boolean
          name_template?: string
          only_outcomes?: Database["public"]["Enums"]["call_outcome"][] | null
          task_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_task_configs_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: true
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
        ]
      }
      agents: {
        Row: {
          created_at: string
          id: string
          name: string
          objective: string | null
          retell_agent_id: string | null
          retell_from_number: string | null
          status: Database["public"]["Enums"]["agent_status"]
          updated_at: string
          workspace_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          objective?: string | null
          retell_agent_id?: string | null
          retell_from_number?: string | null
          status?: Database["public"]["Enums"]["agent_status"]
          updated_at?: string
          workspace_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          objective?: string | null
          retell_agent_id?: string | null
          retell_from_number?: string | null
          status?: Database["public"]["Enums"]["agent_status"]
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agents_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      calls: {
        Row: {
          agent_id: string
          applied_tag: string | null
          attempt_number: number
          completed_at: string | null
          contact_id: string
          dialed_at: string | null
          error_message: string | null
          id: string
          in_voicemail: boolean | null
          outcome: Database["public"]["Enums"]["call_outcome"] | null
          queued_at: string
          raw_payload: Json | null
          retell_call_id: string | null
          status: Database["public"]["Enums"]["call_status"]
          summary: string | null
          task_created: boolean
          to_number: string
          transcript: string | null
          workspace_id: string
        }
        Insert: {
          agent_id: string
          applied_tag?: string | null
          attempt_number: number
          completed_at?: string | null
          contact_id: string
          dialed_at?: string | null
          error_message?: string | null
          id?: string
          in_voicemail?: boolean | null
          outcome?: Database["public"]["Enums"]["call_outcome"] | null
          queued_at?: string
          raw_payload?: Json | null
          retell_call_id?: string | null
          status?: Database["public"]["Enums"]["call_status"]
          summary?: string | null
          task_created?: boolean
          to_number: string
          transcript?: string | null
          workspace_id: string
        }
        Update: {
          agent_id?: string
          applied_tag?: string | null
          attempt_number?: number
          completed_at?: string | null
          contact_id?: string
          dialed_at?: string | null
          error_message?: string | null
          id?: string
          in_voicemail?: boolean | null
          outcome?: Database["public"]["Enums"]["call_outcome"] | null
          queued_at?: string
          raw_payload?: Json | null
          retell_call_id?: string | null
          status?: Database["public"]["Enums"]["call_status"]
          summary?: string | null
          task_created?: boolean
          to_number?: string
          transcript?: string | null
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "calls_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "calls_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      contacts: {
        Row: {
          attempt_count: number
          created_at: string
          crm_contact_id: string
          full_name: string | null
          id: string
          is_terminal: boolean
          last_called_on: string | null
          next_eligible_on: string | null
          phones: string[]
          tags: string[]
          terminal_outcome: Database["public"]["Enums"]["call_outcome"] | null
          updated_at: string
          workspace_id: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          crm_contact_id: string
          full_name?: string | null
          id?: string
          is_terminal?: boolean
          last_called_on?: string | null
          next_eligible_on?: string | null
          phones?: string[]
          tags?: string[]
          terminal_outcome?: Database["public"]["Enums"]["call_outcome"] | null
          updated_at?: string
          workspace_id: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          crm_contact_id?: string
          full_name?: string | null
          id?: string
          is_terminal?: boolean
          last_called_on?: string | null
          next_eligible_on?: string | null
          phones?: string[]
          tags?: string[]
          terminal_outcome?: Database["public"]["Enums"]["call_outcome"] | null
          updated_at?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "contacts_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_members: {
        Row: {
          created_at: string
          organization_id: string
          role: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          organization_id: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          organization_id?: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          email: string
          full_name: string | null
          id: string
        }
        Insert: {
          created_at?: string
          email: string
          full_name?: string | null
          id: string
        }
        Update: {
          created_at?: string
          email?: string
          full_name?: string | null
          id?: string
        }
        Relationships: []
      }
      workspace_outcome_tags: {
        Row: {
          is_terminal: boolean
          outcome: Database["public"]["Enums"]["call_outcome"]
          tag: string
          workspace_id: string
        }
        Insert: {
          is_terminal?: boolean
          outcome: Database["public"]["Enums"]["call_outcome"]
          tag: string
          workspace_id: string
        }
        Update: {
          is_terminal?: boolean
          outcome?: Database["public"]["Enums"]["call_outcome"]
          tag?: string
          workspace_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspace_outcome_tags_workspace_id_fkey"
            columns: ["workspace_id"]
            isOneToOne: false
            referencedRelation: "workspaces"
            referencedColumns: ["id"]
          },
        ]
      }
      workspaces: {
        Row: {
          created_at: string
          created_by: string | null
          crm_credentials_encrypted: string | null
          crm_provider: Database["public"]["Enums"]["crm_provider"]
          enroll_tag: string
          id: string
          is_active: boolean
          name: string
          organization_id: string
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          crm_credentials_encrypted?: string | null
          crm_provider: Database["public"]["Enums"]["crm_provider"]
          enroll_tag?: string
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          crm_credentials_encrypted?: string | null
          crm_provider?: Database["public"]["Enums"]["crm_provider"]
          enroll_tag?: string
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workspaces_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "workspaces_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      seed_default_outcome_tags: {
        Args: { p_workspace_id: string }
        Returns: undefined
      }
      user_org_ids: { Args: never; Returns: string[] }
      user_workspace_ids: { Args: never; Returns: string[] }
    }
    Enums: {
      agent_status: "draft" | "active" | "paused"
      call_outcome:
        | "voicemail"
        | "no_answer"
        | "appointment"
        | "not_interested"
        | "dnd"
        | "interested_no_appointment"
        | "follow_up"
        | "error"
      call_status: "queued" | "dialing" | "completed" | "failed"
      crm_provider: "followupboss" | "highlevel"
      member_role: "owner" | "admin" | "member"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
