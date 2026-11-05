# GitHub Actions → AWS por OIDC: credencial temporária por job, nenhuma chave de longa duração.
# Só o environment "staging" do repositório pode assumir o papel (o environment no GitHub é
# protegido; prod terá papel próprio, em outra conta, com aprovação de sócio).

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # A AWS valida o GitHub pela cadeia de CAs confiáveis; thumbprint não é mais necessário.
}

data "aws_iam_policy_document" "github_confianca" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repositorio}:environment:${local.ambiente}"]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = "${local.nome}-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.github_confianca.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "TokenDoEcr"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # a ação não aceita recurso específico
  }
  statement {
    sid = "PushDaImagemDaApi"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:DescribeImageScanFindings",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.api.arn]
  }
  statement {
    sid       = "NovaRevisaoDaTask"
    actions   = ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"]
    resources = ["*"] # RegisterTaskDefinition não aceita recurso específico
  }
  statement {
    sid       = "DeployDoServico"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [aws_ecs_service.api.id]
  }
  statement {
    sid       = "PassarPapeisDaTask"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.api_execucao.arn, aws_iam_role.api_tarefa.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  # Trava de região: mesmo que alguém amplie as permissões acima, nada fora de sa-east-1.
  statement {
    sid         = "SomenteSaoPaulo"
    effect      = "Deny"
    not_actions = ["iam:*", "sts:*", "support:*"]
    resources   = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = ["sa-east-1"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy-staging"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
